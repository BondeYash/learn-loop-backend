import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import Assessment from "../models/Assessment.js";
import AssessmentAttempt from "../models/AssessmentAttempt.js";
import Module from "../models/Module.js";
import { requireCourseOwner } from "../services/courseService.js";
import { requireCourseAccess } from "../services/courseAccess.js";
import { ASSESSMENT_LIMITS, assessmentChanges, assessmentDTO, attemptDTO, finishAttempt } from "../services/assessments.js";

export const manageAssessments = asyncHandler(async (req, res) => {
  await requireCourseOwner(req.params.courseId, req.user);
  const assessments = await Assessment.find({ course: req.params.courseId }).select("+questions").sort("createdAt").limit(ASSESSMENT_LIMITS.assessments);
  return new ApiResponse(res, 200, "Assessments retrieved", { assessments: assessments.map((a) => assessmentDTO(a, true)) });
});
export const saveAssessment = asyncHandler(async (req, res) => {
  const course = await requireCourseOwner(req.params.courseId, req.user);
  const changes = await assessmentChanges(req.body, course._id);
  let assessment;
  if (req.params.id) {
    if (!Number.isInteger(req.body.version) || req.body.version < 1) throw new ApiError(400, "Refresh the assessment version before saving.");
    assessment = await Assessment.findOneAndUpdate({ _id: req.params.id, course: course._id, version: req.body.version }, { $set: changes, $inc: { version: 1 } }, { new: true, runValidators: true }).select("+questions");
    if (!assessment) throw new ApiError(409, "Assessment changed or is unavailable. Reload before saving.");
  } else {
    for (let retry = 0; retry < 8; retry++) {
      const occupied = new Set((await Assessment.find({ course: course._id }).select("slot")).map((a) => a.slot));
      const slot = Array.from({ length: ASSESSMENT_LIMITS.assessments }, (_, i) => i).find((i) => !occupied.has(i));
      if (slot === undefined) throw new ApiError(409, "This course supports at most 40 assessments.");
      try { assessment = await Assessment.create({ ...changes, course: course._id, slot }); break; }
      catch (e) { if (e.code !== 11000) throw e; }
    }
    if (!assessment) throw new ApiError(409, "Another assessment was created concurrently. Retry safely.");
  }
  return new ApiResponse(res, req.params.id ? 200 : 201, "Assessment saved", { assessment: assessmentDTO(assessment, true) });
});
export const listAssessments = asyncHandler(async (req, res) => {
  await requireCourseAccess(req.params.courseId, req.user);
  const chapters = await Module.find({ course: req.params.courseId }).select("_id");
  const assessments = await Assessment.find({ course: req.params.courseId, status: "published", $or: [{ kind: "mock" }, { module: { $in: chapters.map((m) => m._id) } }] }).sort("createdAt").limit(ASSESSMENT_LIMITS.assessments);
  return new ApiResponse(res, 200, "Available assessments", { assessments: assessments.map((a) => assessmentDTO(a)) });
});
export const startAttempt = asyncHandler(async (req, res) => {
  const assessment = await Assessment.findById(req.params.id).select("+questions");
  if (!assessment) throw new ApiError(404, "Assessment not found.");
  await requireCourseAccess(assessment.course, req.user);
  let active = await AssessmentAttempt.findOne({ student: req.user._id, assessment: assessment._id, status: "active" }).select("+snapshot");
  if (active) { active = await finishAttempt(active); if (active.status === "active") return new ApiResponse(res, 200, "Attempt resumed", { attempt: attemptDTO(active) }); }
  if (assessment.status !== "published" || assessment.kind === "quiz" && !await Module.exists({ _id: assessment.module, course: assessment.course })) throw new ApiError(404, "This assessment is not available for new attempts.");
  const count = await AssessmentAttempt.countDocuments({ student: req.user._id, assessment: assessment._id });
  if (count >= ASSESSMENT_LIMITS.attempts) throw new ApiError(409, "This assessment supports at most 100 attempts per learner.");
  const startedAt = new Date();
  try {
    active = await AssessmentAttempt.create({ student: req.user._id, course: assessment.course, assessment: assessment._id, attemptNumber: count + 1, startedAt, deadline: assessment.durationMinutes ? new Date(startedAt.getTime() + assessment.durationMinutes * 60000) : null,
      snapshot: { title: assessment.title, kind: assessment.kind, version: assessment.version, durationMinutes: assessment.durationMinutes, questions: assessment.questions.map((q) => q.toObject()) }, answers: assessment.questions.map(() => null) });
  } catch (error) {
    if (error.code !== 11000) throw error;
    active = await AssessmentAttempt.findOne({ student: req.user._id, assessment: assessment._id, status: "active" }).select("+snapshot");
    if (!active) throw new ApiError(409, "Attempt changed. Retry safely.");
  }
  return new ApiResponse(res, 200, "Attempt started", { attempt: attemptDTO(active) });
});
async function ownAttempt(req) {
  const attempt = await AssessmentAttempt.findOne({ _id: req.params.id, student: req.user._id }).select("+snapshot");
  if (!attempt) throw new ApiError(404, "Attempt not found.");
  await requireCourseAccess(attempt.course, req.user);
  return attempt;
}
export const getAttempt = asyncHandler(async (req, res) => new ApiResponse(res, 200, "Attempt retrieved", { attempt: attemptDTO(await finishAttempt(await ownAttempt(req))) }));
export const answerAttempt = asyncHandler(async (req, res) => {
  let attempt = await finishAttempt(await ownAttempt(req));
  if (attempt.status !== "active") throw new ApiError(409, "This attempt has ended. Open its result to review it.");
  const { questionIndex, optionIndex } = req.body, question = attempt.snapshot.questions[questionIndex];
  if (!Number.isInteger(questionIndex) || questionIndex < 0 || !question || optionIndex !== null && (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= question.options.length)) throw new ApiError(400, "Choose an option belonging to this question, or null to clear it.");
  const saved = await AssessmentAttempt.findOneAndUpdate({ _id: attempt._id, student: req.user._id, status: "active", $or: [{ deadline: null }, { $expr: { $gt: ["$deadline", "$$NOW"] } }] }, { $set: { [`answers.${questionIndex}`]: optionIndex }, $inc: { revision: 1 } }, { new: true }).select("+snapshot");
  if (!saved) { await finishAttempt(await ownAttempt(req)); throw new ApiError(409, "This attempt has ended. Open its result to review it."); }
  return new ApiResponse(res, 200, "Answer saved", { attempt: attemptDTO(saved) });
});
export const submitAttempt = asyncHandler(async (req, res) => new ApiResponse(res, 200, "Attempt submitted", { attempt: attemptDTO(await finishAttempt(await ownAttempt(req), true)) }));
export const attemptHistory = asyncHandler(async (req, res) => {
  await requireCourseAccess(req.params.courseId, req.user);
  const filter = { course: req.params.courseId, student: req.user._id };
  const active = await AssessmentAttempt.find({ ...filter, status: "active" }).select("+snapshot").limit(ASSESSMENT_LIMITS.assessments);
  await Promise.all(active.map((a) => finishAttempt(a)));
  const page = Number(req.query.page ?? 1);
  if (!Number.isInteger(page) || page < 1 || page > 200) throw new ApiError(400, "Use a history page from 1 to 200.");
  const [attempts, total, recent] = await Promise.all([
    AssessmentAttempt.find(filter).select("+snapshot").sort({ startedAt: -1, _id: -1 }).skip((page - 1) * 20).limit(20), AssessmentAttempt.countDocuments(filter),
    AssessmentAttempt.find({ ...filter, status: { $ne: "active" } }).sort({ submittedAt: -1, _id: -1 }).limit(100),
  ]);
  const topics = new Map();
  for (const a of recent) for (const tag of a.result.topics || []) { const row = topics.get(tag.topic) || { topic: tag.topic, correct: 0, total: 0 }; row.correct += tag.correct; row.total += tag.total; topics.set(tag.topic, row); }
  const weakTopics = [...topics.values()].map((r) => ({ ...r, percentage: Math.round(r.correct / r.total * 100) })).filter((r) => r.percentage < 70).sort((a, b) => a.percentage - b.percentage || a.topic.localeCompare(b.topic));
  return new ApiResponse(res, 200, "Your assessment history", { page, limit: 20, total, summaryWindow: recent.length, weakTopics,
    attempts: attempts.map((a) => ({ id: String(a._id), assessmentId: String(a.assessment), title: a.snapshot.title, version: a.snapshot.version, status: a.status, startedAt: a.startedAt, submittedAt: a.submittedAt, deadline: a.deadline, ...(a.status !== "active" ? { result: a.result } : {}) })) });
});
