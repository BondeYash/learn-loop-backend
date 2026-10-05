import mongoose from "mongoose";
import ApiError from "../utils/ApiError.js";
import AssessmentAttempt from "../models/AssessmentAttempt.js";
import Module from "../models/Module.js";

export const ASSESSMENT_LIMITS = { assessments: 40, questions: 40, attempts: 100, options: 6, minutes: 180 };
const invalid = (message) => { throw new ApiError(400, message); };
const text = (value, maximum, label) => {
  if (typeof value !== "string" || value.length > maximum) invalid(`${label} must be text of at most ${maximum} characters.`);
  return value.trim();
};
export async function assessmentChanges(body, courseId) {
  const title = text(body.title, 160, "Assessment title");
  if (!title) invalid("Assessment title is required.");
  if (!["quiz", "mock"].includes(body.kind)) invalid("Choose a chapter quiz or course mock test.");
  if (!["draft", "published"].includes(body.status)) invalid("Choose draft or published.");
  let module = null;
  if (body.kind === "quiz") {
    if (!mongoose.isValidObjectId(body.module) || !await Module.exists({ _id: body.module, course: courseId })) invalid("Choose a chapter from this course.");
    module = body.module;
  }
  const durationMinutes = body.durationMinutes ?? null;
  if (durationMinutes !== null && (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > ASSESSMENT_LIMITS.minutes)) invalid("The timer must be a whole number from 1 to 180 minutes.");
  if (body.kind === "mock" && durationMinutes === null) invalid("A course mock test requires a timer.");
  if (!Array.isArray(body.questions) || body.questions.length > ASSESSMENT_LIMITS.questions) invalid("Use at most 40 questions.");
  const published = body.status === "published";
  if (published && !body.questions.length) invalid("Add at least one complete question before publishing.");
  const questions = body.questions.map((q, index) => {
    if (!q || typeof q !== "object" || Array.isArray(q)) invalid("Each question must be an object.");
    const prompt = text(q.prompt, 1200, `Question ${index + 1}`), explanation = text(q.explanation ?? "", 2000, "Explanation"), topic = text(q.topic ?? "", 80, "Topic tag");
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > ASSESSMENT_LIMITS.options) invalid("Each question needs 2 to 6 options.");
    const options = q.options.map((o) => text(o, 400, "Option")), correctIndex = q.correctIndex ?? null;
    if (correctIndex !== null && (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length)) invalid("The correct answer must be one of this question's options.");
    if (published && (!prompt || options.some((o) => !o) || correctIndex === null || !explanation)) invalid(`Complete question ${index + 1}, its options, correct answer and explanation before publishing.`);
    if (published && new Set(options.map((o) => o.toLocaleLowerCase())).size !== options.length) invalid("Published options must be distinct.");
    return { prompt, options, correctIndex, explanation, topic };
  });
  return { title, kind: body.kind, module, durationMinutes, status: body.status, questions, questionCount: questions.length };
}
export function scoreAttempt(snapshot, answers) {
  const topics = new Map(); let correct = 0, answered = 0;
  snapshot.questions.forEach((q, i) => {
    const selected = answers[i] ?? null, hit = selected === q.correctIndex;
    if (selected !== null) answered++;
    if (hit) correct++;
    if (q.topic) { const row = topics.get(q.topic) || { topic: q.topic, correct: 0, total: 0 }; row.total++; if (hit) row.correct++; topics.set(q.topic, row); }
  });
  const total = snapshot.questions.length;
  return { correct, total, answered, percentage: total ? Math.round(correct / total * 100) : 0, topics: [...topics.values()] };
}
export function assessmentDTO(value, management = false) {
  return { id: String(value._id), courseId: String(value.course), moduleId: value.module ? String(value.module) : null, title: value.title, kind: value.kind, durationMinutes: value.durationMinutes, questionCount: value.questionCount, status: value.status, version: value.version,
    ...(management ? { questions: value.questions.map((q) => ({ prompt: q.prompt, options: [...q.options], correctIndex: q.correctIndex, explanation: q.explanation, topic: q.topic })) } : {}) };
}
export function attemptDTO(value) {
  const s = value.snapshot;
  const submitted = value.status !== "active";
  return { id: String(value._id), assessmentId: String(value.assessment), courseId: String(value.course), status: value.status, revision: value.revision, title: s.title, kind: s.kind, version: s.version,
    startedAt: value.startedAt, deadline: value.deadline, submittedAt: value.submittedAt, serverNow: new Date(), answers: [...value.answers],
    questions: s.questions.map((q) => ({ prompt: q.prompt, options: [...q.options], topic: q.topic })),
    ...(submitted ? { result: value.result, review: s.questions.map((q, i) => ({ correctIndex: q.correctIndex, explanation: q.explanation, selectedIndex: value.answers[i] ?? null, correct: value.answers[i] === q.correctIndex })) } : {}) };
}
export async function finishAttempt(attempt, explicit = false) {
  for (let retry = 0; retry < 8; retry++) {
    if (attempt.status !== "active") return attempt;
    const now = new Date(), expired = attempt.deadline && attempt.deadline <= now;
    if (!explicit && !expired) return attempt;
    const updated = await AssessmentAttempt.findOneAndUpdate({ _id: attempt._id, status: "active", revision: attempt.revision }, { $set: { status: expired ? "timed_out" : "submitted", submittedAt: now, result: scoreAttempt(attempt.snapshot, attempt.answers) }, $inc: { revision: 1 } }, { new: true }).select("+snapshot");
    if (updated) return updated;
    // An answer racing with submit must be included, rather than scoring a stale read.
    attempt = await AssessmentAttempt.findById(attempt._id).select("+snapshot");
    if (!attempt) throw new ApiError(404, "Attempt not found.");
  }
  throw new ApiError(409, "Answers changed during submission. Retry submission safely.");
}
