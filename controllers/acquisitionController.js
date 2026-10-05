import ApiResponse from "../utils/ApiResponse.js";
import ApiError from "../utils/ApiError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { AcquisitionConfig, AcquisitionChoice, AcquisitionVisit, InterestRequest, SourceLink } from "../models/Acquisition.js";
import { findPublicCourse, safePublicUrl } from "../services/publicCatalog.js";
import { requireCourseOwner } from "../services/courseService.js";
import { acquisitionReport, allowFields, boundedCreate, collectionOptions, interestValues, interestView, requestToken, resolveSource, retained, sourceView, visitValues } from "../services/acquisition.js";
import crypto from "node:crypto";
const ownerCourse = (req) => requireCourseOwner(req.params.courseId, req.user, { allowArchived: req.method === "GET" });
const version = (v) => { if (!Number.isSafeInteger(v) || v < 0) throw new ApiError(400, "A valid current version is required."); };
export const publicOptions = asyncHandler(async (req, res) => new ApiResponse(res, 200, "Optional course requests and measurement", await collectionOptions(await findPublicCourse(req.params.courseId))));
export const recordVisit = asyncHandler(async (req, res) => {
  allowFields(req.body, ["consent", "sourceCode", "requestId"]);
  if (req.body.consent !== true) throw new ApiError(400, "Optional measurement requires your explicit consent.");
  if (req.body.sourceCode !== undefined && (typeof req.body.sourceCode !== "string" || !/^(?:[a-f\d]{12})?$/.test(req.body.sourceCode))) throw new ApiError(400, "Use a registered source code or leave it empty.");
  const course = await findPublicCourse(req.params.courseId), options = await collectionOptions(course);
  if (!options.measurementEnabled) throw new ApiError(409, "Optional course measurement is unavailable.");
  const token = requestToken(req.body.requestId), source = await resolveSource(course._id, req.body.sourceCode);
  await boundedCreate(AcquisitionVisit, course._id, 5000, visitValues(source, token), { requestToken: token });
  return new ApiResponse(res, 200, "Optional page view recorded", { accepted: true });
});
export const requestInterest = asyncHandler(async (req, res) => {
  allowFields(req.body, ["email", "purpose", "contactAcknowledged", "marketingConsent", "requestId"]);
  const { email, purpose, contactAcknowledged, marketingConsent } = req.body;
  if (typeof email !== "string" || email.length > 254 || !/^[a-z\d.!#$%&'*+\/=?^_`{|}~-]+@[a-z\d](?:[a-z\d.-]*[a-z\d])?\.[a-z]{2,}$/i.test(email) || !["interest", "demo"].includes(purpose) || contactAcknowledged !== true || typeof marketingConsent !== "boolean") throw new ApiError(400, "Provide a valid email, request type and permission to respond. Marketing consent is optional.");
  const course = await findPublicCourse(req.params.courseId), options = await collectionOptions(course);
  if (!options.interestEnabled) throw new ApiError(409, "Course interest requests are unavailable.");
  const token = requestToken(req.body.requestId);
  await boundedCreate(InterestRequest, course._id, 500, interestValues(email.toLowerCase(), purpose, marketingConsent, options.policyUrl), { requestToken: token });
  // Public responses never expose contact information or list entries.
  return new ApiResponse(res, 200, "Your request has been saved for the course team. A response is not guaranteed.", { accepted: true });
});
export const getConfig = asyncHandler(async (req, res) => { const course = await ownerCourse(req); return new ApiResponse(res, 200, "Course collection settings", { config: await collectionOptions(course), course: { id: String(course._id), title: course.title, slug: course.slug } }); });
export const saveConfig = asyncHandler(async (req, res) => {
  const course = await ownerCourse(req); allowFields(req.body, ["measurementEnabled", "interestEnabled", "policyReviewed", "version"]);
  const { measurementEnabled, interestEnabled, policyReviewed, version: v } = req.body; version(v);
  if (typeof measurementEnabled !== "boolean" || typeof interestEnabled !== "boolean" || typeof policyReviewed !== "boolean") throw new ApiError(400, "Choose explicit collection settings.");
  if ((measurementEnabled || interestEnabled) && (!safePublicUrl(course.privacyPolicyUrl) || policyReviewed !== true)) throw new ApiError(409, "Add your actual course privacy notice and review its purposes, access and retention before enabling collection.");
  const values = { measurementEnabled, interestEnabled, reviewedPolicyUrl: policyReviewed && safePublicUrl(course.privacyPolicyUrl) ? course.privacyPolicyUrl : "", reviewedAt: policyReviewed ? new Date() : null };
  let config;
  try { config = v === 0 ? await AcquisitionConfig.create({ course: course._id, ...values }) : await AcquisitionConfig.findOneAndUpdate({ course: course._id, version: v }, { $set: values, $inc: { version: 1 } }, { new: true }); }
  catch (e) { if (e.code !== 11000) throw e; }
  if (!config) throw new ApiError(409, "Collection settings changed. Refresh and review before saving.");
  return new ApiResponse(res, 200, "Collection settings saved", { config: await collectionOptions(course) });
});
export const sources = asyncHandler(async (req, res) => { const c = await ownerCourse(req); return new ApiResponse(res, 200, "Registered source links", { sources: (await SourceLink.find({ course: c._id }).sort("slot")).map(sourceView) }); });
export const createSource = asyncHandler(async (req, res) => {
  const c = await ownerCourse(req); allowFields(req.body, ["channel", "label", "requestId"]);
  if (!["website", "social", "search", "referral", "email", "print", "other"].includes(req.body.channel) || typeof req.body.label !== "string" || !/^[a-z][a-z\d-]{0,39}$/.test(req.body.label)) throw new ApiError(400, "Use a generic channel and a campaign label of 1–40 lowercase letters, numbers or hyphens. Do not enter personal information.");
  const source = await boundedCreate(SourceLink, c._id, 20, { channel: req.body.channel, label: req.body.label, code: crypto.randomBytes(6).toString("hex") }, { requestToken: requestToken(req.body.requestId) });
  return new ApiResponse(res, 201, "Source link created", { source: sourceView(source) });
});
export const updateSource = asyncHandler(async (req, res) => {
  const c = await ownerCourse(req); allowFields(req.body, ["active", "version"]); version(req.body.version);
  if (typeof req.body.active !== "boolean") throw new ApiError(400, "Choose whether this source is active.");
  const source = await SourceLink.findOneAndUpdate({ _id: req.params.id, course: c._id, version: req.body.version }, { $set: { active: req.body.active }, $inc: { version: 1 } }, { new: true });
  if (!source) throw new ApiError(409, "Source link changed or is unavailable. Refresh and retry.");
  return new ApiResponse(res, 200, "Source link updated", { source: sourceView(source) });
});
export const report = asyncHandler(async (req, res) => new ApiResponse(res, 200, "Course acquisition aggregates", await acquisitionReport(await ownerCourse(req))));
export const interests = asyncHandler(async (req, res) => {
  const c = await ownerCourse(req), page = Number(req.query.page || 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 25 || Object.keys(req.query).some((key) => key !== "page")) throw new ApiError(400, "Use a page from 1 to 25.");
  const filter = { course: c._id, ...retained() };
  const [items, total] = await Promise.all([InterestRequest.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * 20).limit(20), InterestRequest.countDocuments(filter)]);
  return new ApiResponse(res, 200, "Private course interest requests", { requests: items.map(interestView), page, limit: 20, total });
});
export const interestStatus = asyncHandler(async (req, res) => {
  const c = await ownerCourse(req); allowFields(req.body, ["status", "version"]); version(req.body.version);
  if (!["pending", "contacted", "closed"].includes(req.body.status)) throw new ApiError(400, "Choose a valid request status.");
  const item = await InterestRequest.findOneAndUpdate({ _id: req.params.id, course: c._id, version: req.body.version, ...retained() }, { $set: { status: req.body.status }, $inc: { version: 1 } }, { new: true });
  if (!item) throw new ApiError(409, "Request changed, expired or is unavailable. Refresh and retry.");
  return new ApiResponse(res, 200, "Request status saved; no message was sent", { request: interestView(item) });
});
export const eraseInterest = asyncHandler(async (req, res) => { const c = await requireCourseOwner(req.params.courseId, req.user, { allowArchived: true }); allowFields(req.body, ["version"]); version(req.body.version); const result = await InterestRequest.deleteOne({ _id: req.params.id, course: c._id, version: req.body.version }); if (!result.deletedCount) throw new ApiError(409, "Request changed or is unavailable. Refresh before erasing."); return new ApiResponse(res, 200, "Contact request erased", { erased: true }); });
export const withdrawChoice = asyncHandler(async (req, res) => { await AcquisitionChoice.deleteOne({ course: req.params.courseId, student: req.user._id }); return new ApiResponse(res, 200, "Saved source choice removed", { erased: true }); });
