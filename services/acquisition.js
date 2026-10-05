import crypto from "node:crypto";
import mongoose from "mongoose";
import ApiError from "../utils/ApiError.js";
import Enrollment from "../models/Enrollment.js";
import { LivePaymentOrder } from "../models/PaymentOrder.js";
import { AcquisitionConfig, AcquisitionChoice, AcquisitionVisit, InterestRequest, SourceLink } from "../models/Acquisition.js";
import { safePublicUrl } from "./publicCatalog.js";

export function retentionDays() { const days = Number(process.env.ACQUISITION_RETENTION_DAYS || 90); return Number.isInteger(days) && days >= 1 && days <= 180 ? days : 90; }
const expiry = () => new Date(Date.now() + retentionDays() * 86400000);
export const retained = () => ({ expiresAt: { $gt: new Date() } });
export function allowFields(body, fields) { if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !fields.includes(key))) throw new ApiError(400, "Unexpected request fields."); }
export function requestToken(value) { if (typeof value !== "string" || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value)) throw new ApiError(400, "A valid request identifier is required."); return crypto.createHash("sha256").update(value).digest("hex"); }
export const sourceView = (s) => ({ id: String(s._id), code: s.code, channel: s.channel, label: s.label, active: s.active, version: s.version });
export const interestView = (r) => ({ id: String(r._id), email: r.email, purpose: r.purpose, marketingConsent: r.marketingConsent, marketingConsentAt: r.marketingConsentAt || null, createdAt: r.createdAt, expiresAt: r.expiresAt, status: r.status, version: r.version });
export async function collectionOptions(course) {
  const config = await AcquisitionConfig.findOne({ course: course._id });
  const policyUrl = safePublicUrl(course.privacyPolicyUrl) ? course.privacyPolicyUrl : "";
  const reviewed = Boolean(policyUrl && config?.reviewedPolicyUrl === policyUrl);
  return { measurementEnabled: reviewed && Boolean(config?.measurementEnabled), interestEnabled: reviewed && Boolean(config?.interestEnabled), policyUrl, retentionDays: retentionDays(), version: config?.version || 0 };
}
export async function resolveSource(course, code) {
  if (typeof code !== "string" || !/^[a-f\d]{12}$/.test(code)) return null;
  return SourceLink.findOne({ course, code, active: true });
}
// Unique bounded slots enforce limits even when clients race. Expired records
// remain physically present until MongoDB's TTL monitor removes them.
export async function boundedCreate(Model, course, cap, values, identity = {}) {
  for (let tries = 0; tries < 8; tries++) {
    if (Object.keys(identity).length) { const old = await Model.findOne({ course, ...identity, ...(Model.schema.path("expiresAt") ? retained() : {}) }); if (old) return old; }
    const used = new Set((await Model.find({ course }).select("slot").lean()).map((d) => d.slot));
    let slot = 0; while (used.has(slot)) slot++;
    if (slot >= cap) throw new ApiError(409, "This course's retained record limit has been reached. Please try later or contact the course team.");
    try { return await Model.create({ ...values, ...identity, course, slot }); }
    catch (error) { if (error.code !== 11000) throw error; }
  }
  throw new ApiError(409, "Another request changed this course. Retry with the same request identifier.");
}
export const visitValues = (source, token) => ({ source: source?._id || null, requestToken: token, expiresAt: expiry() });
export const interestValues = (email, purpose, marketingConsent, policyUrl) => ({ email, purpose, marketingConsent, ...(marketingConsent ? { marketingConsentAt: new Date() } : {}), policyUrl, expiresAt: expiry() });
// Optional attribution never changes an enrollment, order or payment outcome.
// A first valid, explicitly consented campaign survives checkout retries. Test
// checkout controllers do not call this function.
export async function captureAttribution(course, user, body) {
  try {
    if (user.role !== "student" || body?.consent !== true || Object.keys(body).some((key) => !["consent", "sourceCode"].includes(key))) return;
    const options = await collectionOptions(course); if (!options.measurementEnabled) return;
    const source = await resolveSource(course._id, body.sourceCode); if (!source) return;
    await AcquisitionChoice.deleteMany({ course: course._id, student: user._id, expiresAt: { $lte: new Date() } });
    await AcquisitionChoice.updateOne({ course: course._id, student: user._id }, { $setOnInsert: { source: source._id, expiresAt: expiry() } }, { upsert: true });
  } catch { /* Collection is elective; never reject canonical access/payment. */ }
}
const zero = () => ({ visits: 0, freeEnrollments: 0, livePaidEnrollments: 0, paidOrders: 0, partialRefunds: 0, fullRefunds: 0, disputes: 0, reversals: 0, receiptsMinor: 0 });
export async function acquisitionReport(course) {
  const courseId = new mongoose.Types.ObjectId(course._id), now = new Date();
  const choiceLookup = [{ $lookup: { from: AcquisitionChoice.collection.name, let: { student: "$student" }, pipeline: [{ $match: { course: courseId, expiresAt: { $gt: now }, $expr: { $eq: ["$student", "$$student"] } } }, { $project: { source: 1 } }], as: "choice" } }, { $set: { source: { $ifNull: [{ $arrayElemAt: ["$choice.source", 0] }, null] } } }];
  const [sources, visits, enrollments, orders, interests] = await Promise.all([
    SourceLink.find({ course: courseId }).sort("slot").lean(),
    AcquisitionVisit.aggregate([{ $match: { course: courseId, expiresAt: { $gt: now } } }, { $group: { _id: "$source", visits: { $sum: 1 } } }]),
    Enrollment.aggregate([{ $match: { course: courseId, $or: [{ publicFreeEnrollment: true }, { publicPurchaseModes: "live" }] } }, { $lookup: { from: LivePaymentOrder.collection.name, localField: "student", foreignField: "student", pipeline: [{ $match: { course: courseId, testMode: false, status: "paid" } }, { $limit: 1 }, { $project: { _id: 1 } }], as: "paid" } }, ...choiceLookup, { $group: { _id: "$source", freeEnrollments: { $sum: { $cond: ["$publicFreeEnrollment", 1, 0] } }, livePaidEnrollments: { $sum: { $cond: [{ $and: [{ $ne: ["$publicFreeEnrollment", true] }, { $gt: [{ $size: "$paid" }, 0] }] }, 1, 0] } } } }]),
    LivePaymentOrder.aggregate([{ $match: { course: courseId, testMode: false, status: { $in: ["paid", "partially_refunded", "refunded", "disputed", "reversed"] } } }, ...choiceLookup, { $group: { _id: "$source", ...Object.fromEntries([["paidOrders", "paid"], ["partialRefunds", "partially_refunded"], ["fullRefunds", "refunded"], ["disputes", "disputed"], ["reversals", "reversed"]].map(([key, status]) => [key, { $sum: { $cond: [{ $eq: ["$status", status] }, 1, 0] } }])), receiptsMinor: { $sum: { $cond: [{ $in: ["$status", ["paid", "partially_refunded"]] }, { $max: [0, { $subtract: ["$amountMinor", { $min: ["$amountMinor", { $ifNull: ["$refundedMinor", 0] }] }] }] }, 0] } } } }]),
    InterestRequest.aggregate([{ $match: { course: courseId, expiresAt: { $gt: now } } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
  ]);
  const rows = new Map(sources.map((s) => [String(s._id), { ...sourceView(s), ...zero() }]));
  rows.set("unknown", { id: "unknown", label: "Unknown / unattributed", channel: "unknown", active: false, ...zero() });
  for (const values of [visits, enrollments, orders]) for (const value of values) { const row = rows.get(String(value._id)) || rows.get("unknown"); for (const [key, count] of Object.entries(value)) if (key !== "_id") row[key] += count; }
  const totals = zero(); for (const row of rows.values()) for (const key of Object.keys(totals)) totals[key] += row[key];
  return { course: { id: String(course._id), title: course.title, slug: course.slug }, rows: [...rows.values()], totals, interest: { pending: 0, contacted: 0, closed: 0, ...Object.fromEntries(interests.map((r) => [r._id, r.count])) }, retentionDays: retentionDays(), generatedAt: now, definitions: { visits: "Retained consented page views, not unique people; client reports may include bots or test browsing.", enrollments: "All-time recorded public free enrollments and public live enrollments with a currently paid live order. Test purchases and refunded/disputed/reversed paid access are excluded.", receipts: "All-time live recorded receipts before fees and taxes, with recorded refunds deducted. Fully refunded, disputed and reversed orders contribute zero. This is not accounting revenue.", attribution: "First retained consented source for this account and course, reported by the client; not verified causality. Unknown includes no consent, missing/expired source choices and unrecognized labels. Choices and views expire; older canonical records can become unattributed. No conversion rates are calculated." } };
}
