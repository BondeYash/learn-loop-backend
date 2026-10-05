import mongoose from "mongoose";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import { PracticalTask, PracticalRecord, CourseQuestion } from "../models/LearningSupport.js";
import Lesson from "../models/Lesson.js";
import { requireCourseOwner } from "../services/courseService.js";
import { requireCourseAccess, managesCourse } from "../services/courseAccess.js";
const text = (v, max, label, empty = false) => { if (typeof v !== "string" || v.length > max || !empty && !v.trim()) throw new ApiError(400, `${label} must contain ${empty ? "0" : "1"}–${max} characters.`); return v.trim(); };
const requestId = (v) => { if (typeof v !== "string" || !/^[a-f\d-]{36}$/i.test(v)) throw new ApiError(400, "Use a stable request identifier when retrying."); return v; };
const integer = (v) => { if (!Number.isSafeInteger(v) || v < 0) throw new ApiError(400, "Reload the current version before saving."); return v; };
const pageNumber = (req) => { const page = Number(req.query.page ?? 1); if (!Number.isInteger(page) || page < 1 || page > 1000) throw new ApiError(400, "Use a page from 1 to 1000."); return page; };
async function lessonFor(course, id) { if (!id) return null; if (!mongoose.isValidObjectId(id) || !await Lesson.exists({ _id: id, course })) throw new ApiError(400, "Choose an existing lesson from this course."); return id; }
async function access(req) { return req.user.role === "student" ? requireCourseAccess(req.params.courseId, req.user) : requireCourseOwner(req.params.courseId, req.user); }
const recordDTO = (r) => r ? { id: String(r._id), taskId: String(r.task), taskVersion: r.taskVersion, taskTitle: r.taskTitle, response: r.response, checked: r.checked, completed: r.completed, completedAt: r.completedAt, revision: r.revision, ...(r.student?.name ? { studentName: r.student.name } : {}), updatedAt: r.updatedAt } : null;
const questionDTO = (q, owner = false) => ({ id: String(q._id), text: q.text, lessonId: q.lesson ? String(q.lesson) : null, replies: q.replies.map((r) => ({ text: r.text, name: r.name, createdAt: r.createdAt })), status: q.resolved ? "resolved" : q.replies.length ? "answered" : "pending", version: q.version, createdAt: q.createdAt, updatedAt: q.updatedAt, ...(owner && q.student?.name ? { studentName: q.student.name } : {}) });
export const listTasks = asyncHandler(async (req, res) => {
  const course = await access(req), owner = managesCourse(course, req.user), lessons = await Lesson.find({ course: course._id }).select("_id");
  const tasks = await PracticalTask.find({ course: course._id, ...(owner ? {} : { active: true, $or: [{ lesson: null }, { lesson: { $in: lessons.map((l) => l._id) } }] }) }).sort("slot").limit(40);
  const records = owner ? [] : (await Promise.all(tasks.map((t) => PracticalRecord.findOne({ student: req.user._id, task: t._id }).sort("-taskVersion")))).filter(Boolean);
  return new ApiResponse(res, 200, "Practical tasks", { tasks: tasks.map((t) => ({ id: String(t._id), lessonId: t.lesson ? String(t.lesson) : null, title: t.title, instructions: t.instructions, checklist: t.checklist, active: t.active, version: t.version, record: recordDTO(records.find((r) => String(r.task) === String(t._id))) })) });
});
export const saveTask = asyncHandler(async (req, res) => {
  const course = await requireCourseOwner(req.params.courseId, req.user), b = req.body;
  const changes = { title: text(b.title, 160, "Task title"), instructions: text(b.instructions, 5000, "Task instructions"), lesson: await lessonFor(course._id, b.lesson), active: b.active };
  if (typeof b.active !== "boolean" || !Array.isArray(b.checklist) || b.checklist.length > 20) throw new ApiError(400, "Use an availability flag and at most 20 checklist items.");
  changes.checklist = b.checklist.map((v) => text(v, 200, "Checklist item")); let task;
  if (req.params.id) {
    task = await PracticalTask.findOneAndUpdate({ _id: req.params.id, course: course._id, version: integer(b.version) }, { $set: changes, $inc: { version: 1 } }, { new: true });
    if (!task) throw new ApiError(409, "Task changed. Reload before saving.");
  } else {
    for (let i = 0; i < 8; i++) {
      const occupied = new Set((await PracticalTask.find({ course: course._id }).select("slot")).map((t) => t.slot));
      const slot = Array.from({ length: 40 }, (_, n) => n).find((n) => !occupied.has(n)); if (slot === undefined) throw new ApiError(409, "This course supports 40 practical tasks.");
      try { task = await PracticalTask.create({ course: course._id, slot, ...changes }); break; } catch (e) { if (e.code !== 11000) throw e; }
    }
    if (!task) throw new ApiError(409, "Tasks changed concurrently. Retry safely.");
  }
  return new ApiResponse(res, 200, "Task saved", { task: { id: String(task._id), lessonId: task.lesson ? String(task.lesson) : null, ...changes, version: task.version } });
});
export const savePracticalRecord = asyncHandler(async (req, res) => {
  const task = await PracticalTask.findById(req.params.id); if (!task || !task.active) throw new ApiError(404, "Task unavailable.");
  await requireCourseAccess(task.course, req.user); if (task.lesson && !await Lesson.exists({ _id: task.lesson, course: task.course })) throw new ApiError(404, "Task lesson unavailable.");
  const b = req.body, id = requestId(b.requestId), taskVersion = integer(b.taskVersion);
  let record = await PracticalRecord.findOne({ task: task._id, student: req.user._id, taskVersion });
  if (record?.requestId === id) return new ApiResponse(res, 200, "Practical record saved", { record: recordDTO(record) });
  if (taskVersion !== task.version) throw new ApiError(409, "The task instructions changed. Reload before recording completion.");
  if (typeof b.completed !== "boolean" || !Array.isArray(b.checked) || b.checked.length !== task.checklist.length || b.checked.some((v) => typeof v !== "boolean") || b.completed && b.checked.some((v) => !v)) throw new ApiError(400, "Check every authored item before recording self-reported completion.");
  const values = { response: text(b.response, 3000, "Text response", true), checked: b.checked, completed: b.completed, ...(b.completed ? { completedAt: record?.completedAt || new Date() } : { completedAt: null }), requestId: id };
  if (record) record = await PracticalRecord.findOneAndUpdate({ _id: record._id, revision: integer(b.revision) }, { $set: values, $inc: { revision: 1 } }, { new: true });
  else {
    if (integer(b.revision) !== 0) throw new ApiError(409, "Reload your practical record before saving.");
    try { record = await PracticalRecord.create({ task: task._id, course: task.course, student: req.user._id, taskVersion, taskTitle: task.title, ...values }); }
    catch (e) { if (e.code !== 11000) throw e; record = await PracticalRecord.findOne({ task: task._id, student: req.user._id, taskVersion, requestId: id }); }
  }
  if (!record) throw new ApiError(409, "Your record changed. Reload before saving.");
  return new ApiResponse(res, 200, "Self-reported practical record saved", { record: recordDTO(record) });
});
export const practicalRecords = asyncHandler(async (req, res) => {
  await requireCourseOwner(req.params.courseId, req.user); const page = pageNumber(req), filter = { course: req.params.courseId };
  const [records, total] = await Promise.all([PracticalRecord.find(filter).populate("student", "name").sort({ updatedAt: -1, _id: -1 }).skip((page - 1) * 20).limit(20), PracticalRecord.countDocuments(filter)]);
  return new ApiResponse(res, 200, "Private practical responses", { records: records.map(recordDTO), total, page, limit: 20 });
});
export const listQuestions = asyncHandler(async (req, res) => {
  const course = await access(req), owner = managesCourse(course, req.user), page = pageNumber(req), filter = { course: course._id, ...(owner ? {} : { student: req.user._id }) };
  const query = CourseQuestion.find(filter).sort({ updatedAt: -1, _id: -1 }).skip((page - 1) * 20).limit(20); if (owner) query.populate("student", "name");
  const [questions, total] = await Promise.all([query, CourseQuestion.countDocuments(filter)]);
  return new ApiResponse(res, 200, "Private course questions", { questions: questions.map((q) => questionDTO(q, owner)), page, limit: 20, total });
});
export const askQuestion = asyncHandler(async (req, res) => {
  await requireCourseAccess(req.params.courseId, req.user); const id = requestId(req.body.requestId), filter = { student: req.user._id, course: req.params.courseId };
  const existing = await CourseQuestion.findOne({ ...filter, requestId: id }); if (existing) return new ApiResponse(res, 200, "Question saved", { question: questionDTO(existing) });
  const values = { text: text(req.body.text, 2000, "Course question"), lesson: await lessonFor(req.params.courseId, req.body.lesson), requestId: id }; let question;
  for (let retry = 0; retry < 8; retry++) {
    const occupied = new Set((await CourseQuestion.find(filter).select("slot")).map((q) => q.slot)), slot = Array.from({ length: 50 }, (_, i) => i).find((i) => !occupied.has(i));
    if (slot === undefined) throw new ApiError(409, "You can retain 50 question threads per course.");
    try { question = await CourseQuestion.create({ ...filter, ...values, slot }); break; } catch (e) { if (e.code !== 11000) throw e; const same = await CourseQuestion.findOne({ ...filter, requestId: id }); if (same) { question = same; break; } }
  }
  if (!question) throw new ApiError(409, "Questions changed concurrently. Retry safely.");
  return new ApiResponse(res, 200, "Question saved privately", { question: questionDTO(question) });
});
export const replyQuestion = asyncHandler(async (req, res) => {
  const question = await CourseQuestion.findById(req.params.id); if (!question) throw new ApiError(404, "Question not found.");
  await requireCourseOwner(question.course, req.user); const id = requestId(req.body.requestId);
  if (question.replies.some((r) => r.requestId === id)) return new ApiResponse(res, 200, "Reply saved", { question: questionDTO(question) });
  if (question.resolved || question.replies.length >= 10) throw new ApiError(409, "The thread is resolved or has reached its 10-reply limit.");
  const updated = await CourseQuestion.findOneAndUpdate({ _id: question._id, version: integer(req.body.version), resolved: false }, { $push: { replies: { text: text(req.body.text, 2000, "Reply"), name: req.user.name, createdAt: new Date(), requestId: id } }, $inc: { version: 1 } }, { new: true });
  if (!updated) { const same = await CourseQuestion.findById(question._id); if (same?.replies.some((r) => r.requestId === id)) return new ApiResponse(res, 200, "Reply saved", { question: questionDTO(same) }); throw new ApiError(409, "Thread changed. Reload before replying."); }
  return new ApiResponse(res, 200, "Reply saved privately", { question: questionDTO(updated) });
});
export const resolveQuestion = asyncHandler(async (req, res) => {
  const question = await CourseQuestion.findOne({ _id: req.params.id, student: req.user._id }); if (!question) throw new ApiError(404, "Question not found.");
  await requireCourseAccess(question.course, req.user); if (typeof req.body.resolved !== "boolean") throw new ApiError(400, "Use a resolved flag.");
  if (question.resolved === req.body.resolved) return new ApiResponse(res, 200, "Thread status saved", { question: questionDTO(question) });
  const updated = await CourseQuestion.findOneAndUpdate({ _id: question._id, version: integer(req.body.version) }, { $set: { resolved: req.body.resolved }, $inc: { version: 1 } }, { new: true });
  if (!updated) throw new ApiError(409, "Thread changed. Reload its latest reply before updating status.");
  return new ApiResponse(res, 200, "Thread status saved", { question: questionDTO(updated) });
});
