import crypto from "node:crypto";
import mongoose from "mongoose";
import { DoubtSettings, DoubtDocument, DoubtTurn, DoubtUsage, DoubtLock } from "../models/DoubtDost.js";
import Course from "../models/Course.js";
import { requireCourseAccess } from "../services/courseAccess.js";
import { findSession } from "../middleware/auth.js";
import { validatePdf, safePdfName } from "../services/pdfValidation.js";
import { doubtSettings, reserveUsage, answerAllowance, monthKey, dayKey, modelName } from "../services/doubtUsage.js";
import { doubtProvider, providerConfigured, groundedAnswer } from "../services/doubtProvider.js";
import { doubtStorage } from "../services/doubtStorage.js";
import { doubtReadiness } from "../services/doubtReadiness.js";
import { answerWithDeadline } from "../services/doubtAnswerDeadline.js";
import { SEARCH_VERSION, retrievePassages } from "../services/doubtRetrieval.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
const storage = req => req.app.locals.doubtStorage || doubtStorage();
const provider = req => req.app.locals.doubtProvider || doubtProvider();
const configured = req => Boolean(req.app.locals.doubtProvider) || providerConfigured();
const docDto = doc => ({ id: doc._id, filename: doc.title || doc.filename, size: doc.size, pages: doc.pages, textPages: doc.textPages, status: doc.status === "ready" && doc.searchVersion !== SEARCH_VERSION ? "indexing" : doc.status, published: doc.published, error: doc.error, createdAt: doc.createdAt });
const pageOf = req => Math.min(10000, Math.max(1, Number(req.query.page) || 1));
async function courseFor(req) {
  const course = await Course.findById(req.params.courseId);
  if (!course) throw new ApiError(404, "Course not found.");
  if (course.archivedAt) throw new ApiError(410, "Restore the course before changing its knowledge base.");
  return course;
}
const documentsFor = (course, preview) => DoubtDocument.find({ course, status: "ready", searchVersion: SEARCH_VERSION, ...(preview ? {} : { published: true }) }).select("_id filename title pages");
async function turnDto(turn, preview = false, documents = null) {
  const docs = documents || await documentsFor(turn.course, preview), allowed = new Set(docs.map(doc => String(doc._id)));
  const changed = turn.status === "answered" && turn.sources.some(source => !allowed.has(String(source.document)));
  return { id: turn._id, requestId: turn.requestId, question: turn.question, answer: changed ? "The source material has changed. Please ask this question again." : turn.answer || "", status: changed ? "unanswered" : turn.status === "pending" && turn.leaseUntil < new Date() ? "failed" : turn.status, language: turn.language, sources: changed ? [] : turn.sources.map(source => ({ documentId: source.document, filename: source.filename, page: source.page, excerpt: source.excerpt })), feedback: turn.feedback, createdAt: turn.createdAt };
}
export const adminOverview = asyncHandler(async (req, res) => {
  const [settings, usage, stored, courses] = await Promise.all([doubtSettings(), DoubtUsage.findById(monthKey()), DoubtUsage.findById("storage"), Course.find({ archivedAt: null }).select("title").sort("title").limit(1000).lean()]);
  return new ApiResponse(res, 200, "Doubt Dost workspace", { settings, configured: configured(req), provider: "Groq", model: modelName(), usage: { answers: usage?.answers || 0, pages: usage?.pages || 0, bytes: stored?.bytes || 0, inputTokens: usage?.inputTokens || 0, outputTokens: usage?.outputTokens || 0 }, courses: courses.map(course => ({ id: course._id, title: course.title })) });
});
export const saveSettings = asyncHandler(async (req, res) => {
  const input = req.body, fields = { enabled: input.enabled, updatedBy: req.user._id };
  if (typeof input.enabled !== "boolean") throw new ApiError(400, "Choose whether Doubt Dost is enabled.");
  for (const [key, max] of Object.entries({ monthlyAnswers: 10000, dailyAnswers: 200, monthlyPages: 10000, storageMb: 1000, courseDocuments: 1000 })) {
    if (!Number.isInteger(input[key]) || input[key] < 1 || input[key] > max) throw new ApiError(400, `${key} must be a whole number from 1 to ${max}.`);
    fields[key] = input[key];
  }
  const settings = await DoubtSettings.findOneAndUpdate({ _id: "global" }, fields, { upsert: true, new: true, setDefaultsOnInsert: true });
  return new ApiResponse(res, 200, "Doubt Dost settings saved", { settings });
});
export const listDocuments = asyncHandler(async (req, res) => {
  const course = await courseFor(req), page = pageOf(req);
  const [documents, total, indexedDocuments] = await Promise.all([DoubtDocument.find({ course: course._id }).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * 20).limit(20), DoubtDocument.countDocuments({ course: course._id }), DoubtDocument.countDocuments({ course: course._id, status: "ready", searchVersion: SEARCH_VERSION })]);
  return new ApiResponse(res, 200, "Knowledge base PDFs", { course: { id: course._id, title: course.title }, documents: documents.map(docDto), total, indexedDocuments, page, limit: 20 });
});
export const uploadDocument = asyncHandler(async (req, res) => {
  await courseFor(req);
  if (!req.file) throw new ApiError(400, "Choose a PDF.");
  if (!/^[a-f0-9-]{36}$/i.test(req.body.uploadId || "")) throw new ApiError(400, "A valid upload identifier is required.");
  if (!process.env.R2_BUCKET && !req.app.locals.doubtStorage) throw new ApiError(503, "Private PDF storage needs to be configured.");
  const sha256 = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
  let doc = await DoubtDocument.findOne({ course: req.params.courseId, $or: [{ uploadId: req.body.uploadId }, { sha256, status: { $ne: "removing" } }] });
  if (doc && doc.sha256 !== sha256) throw new ApiError(409, "Select the file again to start a new upload.");
  if (doc && ["queued", "indexing", "ready"].includes(doc.status)) return new ApiResponse(res, 200, "PDF already received", { document: docDto(doc) });
  const pages = await validatePdf(req.file.buffer), settings = await doubtSettings();
  if (doc) {
    doc = await DoubtDocument.findOneAndUpdate({ _id: doc._id, $or: [{ status: "failed" }, { status: "uploading", leaseUntil: { $lt: new Date() } }] }, { status: "uploading", indexingCharged: false, indexStartedAt: null, operationName: null, providerDocument: null, leaseUntil: new Date(Date.now() + 90000) }, { new: true });
    if (!doc) throw new ApiError(409, "This PDF is still being processed or removed. Refresh the library.");
  } else {
    await reserveUsage(`course:${req.params.courseId}`, "documents", 1, settings.courseDocuments);
    try { await reserveUsage("storage", "bytes", req.file.size, settings.storageMb * 1024 ** 2); }
    catch (e) { await DoubtUsage.updateOne({ _id: `course:${req.params.courseId}` }, { $inc: { documents: -1 } }); throw e; }
    const id = new mongoose.Types.ObjectId();
    try { doc = await DoubtDocument.create({ _id: id, course: req.params.courseId, owner: req.user._id, uploadId: req.body.uploadId, filename: safePdfName(req.file.originalname), title: req.file.originalname.replace(/[\u0000-\u001f\u007f/\\]/g, "_").normalize("NFC").slice(0, 160), size: req.file.size, pages, sha256, storageBucket: process.env.R2_BUCKET, objectKey: `knowledge/${req.params.courseId}/${id}.pdf`, leaseUntil: new Date(Date.now() + 90000) }); }
    catch (e) { await Promise.all([DoubtUsage.updateOne({ _id: "storage" }, { $inc: { bytes: -req.file.size } }), DoubtUsage.updateOne({ _id: `course:${req.params.courseId}` }, { $inc: { documents: -1 } })]); throw e.code === 11000 ? new ApiError(409, "This PDF is already uploading or awaiting removal. Refresh the library.") : e; }
  }
  try {
    await storage(req).upload(doc, req.file.buffer); await courseFor(req);
    const queued = await DoubtDocument.findOneAndUpdate({ _id: doc._id, status: "uploading", leaseUntil: doc.leaseUntil }, { status: "queued", error: "", leaseUntil: null, nextAttemptAt: null }, { new: true });
    if (!queued) throw new ApiError(409, "The PDF changed during upload. Refresh the library.");
    return new ApiResponse(res, 201, "PDF queued for indexing", { document: docDto(queued) });
  } catch (e) { await DoubtDocument.updateOne({ _id: doc._id, status: "uploading", leaseUntil: doc.leaseUntil }, { status: "failed", leaseUntil: null, error: "PDF upload could not be confirmed. Select the same file to retry, or remove this entry." }); throw e instanceof ApiError ? e : new ApiError(503, "PDF upload could not be confirmed. Select the same file to retry."); }
});
export const updateDocument = asyncHandler(async (req, res) => {
  await courseFor(req);
  const doc = await DoubtDocument.findOne({ _id: req.params.documentId, course: req.params.courseId });
  if (!doc) throw new ApiError(404, "Knowledge base PDF not found.");
  if (req.body.action === "publish" || req.body.action === "unpublish") {
    const updated = await DoubtDocument.findOneAndUpdate({ _id: doc._id, status: "ready" }, { published: req.body.action === "publish", publishedAt: req.body.action === "publish" ? new Date() : null }, { new: true });
    if (!updated) throw new ApiError(409, "Only indexed PDFs can be published.");
    return new ApiResponse(res, 200, "PDF availability saved", { document: docDto(updated) });
  }
  if (req.body.action === "retry") {
    const updated = await DoubtDocument.findOneAndUpdate({ _id: doc._id, status: "failed" }, { status: "queued", leaseUntil: null, nextAttemptAt: null, error: "", indexingCharged: false, indexStartedAt: null, operationName: null, providerDocument: null }, { new: true });
    if (!updated) throw new ApiError(409, "Only a failed PDF can be retried.");
    return new ApiResponse(res, 200, "Indexing queued", { document: docDto(updated) });
  }
  throw new ApiError(400, "Choose publish, unpublish or retry.");
});
export const removeDocument = asyncHandler(async (req, res) => {
  await courseFor(req);
  const doc = await DoubtDocument.findOneAndUpdate({ _id: req.params.documentId, course: req.params.courseId }, { status: "removing", published: false, nextAttemptAt: null }, { new: true });
  if (!doc) throw new ApiError(404, "Knowledge base PDF not found.");
  return new ApiResponse(res, 200, "PDF hidden; removal queued", {});
});
export const documentLink = asyncHandler(async (req, res) => {
  if (req.user.role === "admin") await courseFor(req); else await requireCourseAccess(req.params.courseId, req.user);
  const doc = await DoubtDocument.findOne({ _id: req.params.documentId, course: req.params.courseId, status: "ready", ...(req.user.role === "admin" ? {} : { published: true }) });
  if (!doc) throw new ApiError(404, "This PDF is no longer available.");
  return new ApiResponse(res, 200, "Temporary source link", await storage(req).link(doc, false));
});
export const studentChat = asyncHandler(async (req, res) => {
  const course = await requireCourseAccess(req.params.courseId, req.user), settings = await doubtSettings();
  const [states, turns, daily] = await Promise.all([DoubtDocument.find({ course: course._id }).select("_id filename title pages searchVersion status published").lean(), DoubtTurn.find({ course: course._id, student: req.user._id }).sort({ createdAt: -1, _id: -1 }).limit(30), DoubtUsage.findById(dayKey(req.user._id))]);
  const docs = states.filter(doc => doc.status === "ready" && doc.searchVersion === SEARCH_VERSION && doc.published);
  const readiness = doubtReadiness({ enabled: settings.enabled, configured: configured(req), documents: states });
  return new ApiResponse(res, 200, "Doubt Dost", { course: { id: course._id, title: course.title }, available: readiness.code === "ready", readiness, dailyRemaining: Math.max(0, settings.dailyAnswers - (daily?.answers || 0)), documents: docs.length, turns: await Promise.all(turns.reverse().map(turn => turnDto(turn, false, docs))) });
});
export const askDoubt = asyncHandler(async (req, res) => {
  const preview = req.user.role === "admin";
  if (preview) await courseFor(req); else await requireCourseAccess(req.params.courseId, req.user);
  const { question, requestId, language = "hinglish" } = req.body;
  if (typeof question !== "string" || !question.trim() || question.trim().length > 2000 || !/^[a-f0-9-]{36}$/i.test(requestId || "") || !["hi", "en", "hinglish"].includes(language)) throw new ApiError(400, "Enter a doubt up to 2,000 characters and choose a supported language.");
  const existing = await DoubtTurn.findOne({ student: req.user._id, requestId });
  if (existing) {
    if (String(existing.course) !== req.params.courseId || existing.question !== question.trim() || existing.language !== language) throw new ApiError(409, "This request identifier belongs to another question.");
    return new ApiResponse(res, 200, "Existing answer", { turn: await turnDto(existing, preview) });
  }
  const settings = await doubtSettings();
  if (!settings.enabled || !configured(req)) throw new ApiError(503, "Doubt Dost is being prepared. Please ask your instructor for now.");
  const documents = await documentsFor(req.params.courseId, preview);
  if (!documents.length) throw new ApiError(409, "This course's PDFs are not ready and published yet. Please ask your instructor for now.");
  const lockId = `${req.user._id}:${req.params.courseId}`, leaseUntil = new Date(Date.now() + 90000);
  try { await DoubtLock.findOneAndUpdate({ _id: lockId, leaseUntil: { $lt: new Date() } }, { leaseUntil }, { upsert: true }); }
  catch (e) { if (e.code === 11000) throw new ApiError(409, "An answer is already being prepared. Please wait for it before asking again."); throw e; }
  let turn;
  try {
    turn = await DoubtTurn.create({ course: req.params.courseId, student: req.user._id, requestId, question: question.trim(), language, leaseUntil, model: modelName() });
    const monthly = await answerAllowance(settings, req.user._id);
    const recent = await DoubtTurn.find({ course: req.params.courseId, student: req.user._id, status: "answered", _id: { $ne: turn._id } }).sort({ createdAt: -1 }).limit(3);
    const history = [];
    for (const item of recent.reverse()) if (item.sources.every(source => documents.some(doc => String(doc._id) === String(source.document)))) history.push({ question: item.question, answer: item.answer.slice(0, 2500) });
    const ai = provider(req);
    const result = await answerWithDeadline({ answer: async ({ signal }) => {
      let passages = await retrievePassages(new mongoose.Types.ObjectId(req.params.courseId), documents, question.trim());
      let rewriteUsage = { inputTokens: 0, outputTokens: 0 };
      if (ai.rewrite && (!passages.length || /[\u0900-\u097f]/.test(question))) {
        const rewrite = await ai.rewrite({ question: question.trim(), history, signal }); rewriteUsage = rewrite.usage;
        passages = await retrievePassages(new mongoose.Types.ObjectId(req.params.courseId), documents, question.trim() + " " + rewrite.query);
      }
      const answer = passages.length ? await ai.answer({ documents, passages, question: question.trim(), language, history, signal }) : { supported: false, complete: true, usage: {} };
      return { ...answer, passages, usage: { inputTokens: (answer.usage?.inputTokens || 0) + (rewriteUsage?.inputTokens || 0), outputTokens: (answer.usage?.outputTokens || 0) + (rewriteUsage?.outputTokens || 0) } };
    } }, {});
    const live = await findSession(req);
    if (!live || preview && live.user.role !== "admin") throw new ApiError(401, "Your session has ended. Please sign in again.");
    if (preview) await courseFor(req); else await requireCourseAccess(req.params.courseId, live.user);
    const current = await documentsFor(req.params.courseId, preview), answer = groundedAnswer(result, current, result.passages, language);
    const inputTokens = Math.max(0, Math.min(2000000, Number(result.usage?.inputTokens) || 0));
    const outputTokens = Math.max(0, Math.min(2000000, Number(result.usage?.outputTokens) || 0));
    await DoubtUsage.updateOne({ _id: monthly }, { $inc: { inputTokens, outputTokens } });
    Object.assign(turn, answer, { inputTokens, outputTokens }); await turn.save();
    return new ApiResponse(res, 201, "Doubt Dost replied", { turn: await turnDto(turn, preview, current) });
  } catch (e) { if (turn) await DoubtTurn.updateOne({ _id: turn._id }, { status: "failed", answer: e instanceof ApiError && [429, 503, 504].includes(e.statusCode) ? e.message : "The answer could not be completed. Please try again or ask your instructor.", sources: [] }); throw e; }
  finally { await DoubtLock.deleteOne({ _id: lockId, leaseUntil }); }
});
export const feedback = asyncHandler(async (req, res) => {
  await requireCourseAccess(req.params.courseId, req.user);
  if (!["helpful", "unhelpful"].includes(req.body.feedback)) throw new ApiError(400, "Choose helpful or unhelpful.");
  const turn = await DoubtTurn.findOneAndUpdate({ _id: req.params.turnId, course: req.params.courseId, student: req.user._id, status: { $in: ["answered", "unanswered"] } }, { feedback: req.body.feedback }, { new: true });
  if (!turn) throw new ApiError(404, "Your answer was not found.");
  return new ApiResponse(res, 200, "Feedback saved", {});
});
export const activity = asyncHandler(async (req, res) => {
  const page = pageOf(req), filter = { ...(req.query.courseId && mongoose.isValidObjectId(req.query.courseId) ? { course: req.query.courseId } : {}), ...(req.query.needsHelp === "true" ? { $or: [{ status: { $in: ["failed", "unanswered"] } }, { feedback: "unhelpful" }] } : {}) };
  const [turns, total] = await Promise.all([DoubtTurn.find(filter).sort({ createdAt: -1 }).skip((page - 1) * 20).limit(20).populate("course", "title"), DoubtTurn.countDocuments(filter)]);
  return new ApiResponse(res, 200, "Doubt Dost activity", { turns: turns.map(turn => ({ id: turn._id, courseTitle: turn.course?.title || "Removed course", question: turn.question, status: turn.status, feedback: turn.feedback, createdAt: turn.createdAt })), total, page, limit: 20 });
});
