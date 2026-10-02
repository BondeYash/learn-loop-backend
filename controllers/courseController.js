import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import mongoose from "mongoose";
import Course from "../models/Course.js";
import Enrollment from "../models/Enrollment.js";
import VideoAsset from "../models/VideoAsset.js";
import { catalogOutline, managesCourse, requireCourseAccess } from "../services/courseAccess.js";
import Module from "../models/Module.js";
import Lesson from "../models/Lesson.js";
import { ensureCourseReady } from "../services/courseReadiness.js";
import { archiveCourse, restoreCourse, courseCurriculum, ensureCategory, requireCourseOwner } from "../services/courseService.js";
import { withCoursePayments } from "../services/coursePayments.js";

const allowedFields = ["title", "description", "category", "price", "level", "language", "requirements", "learningOutcomes"];
const pickCourseFields = (body) => Object.fromEntries(allowedFields.filter((field) => body[field] !== undefined).map((field) => [field, body[field]]));

export const listCourses = asyncHandler(async (req, res) => {
  let filter = req.user.role === "admin" ? {} : { instructor: req.user._id };
  let assignments = [];
  if (req.user.role === "student") {
    assignments = await Enrollment.find({ student: req.user._id, assignedBy: { $exists: true } }).select("course status");
    filter = { isPublished: true };
  }
  filter.archivedAt = null;
  const courses = await Course.find(filter).populate("instructor", "name avatar").populate("category", "name slug").sort("-publishedAt");
  if (req.user.role !== "student") return new ApiResponse(res, 200, "Courses retrieved", { courses });
  const assigned = new Map(assignments.map((item) => [String(item.course), item.status]));
  const withPayments = await withCoursePayments(courses, req.user._id);
  return new ApiResponse(res, 200, "Courses retrieved", { courses: withPayments.map((course) => {
    const status = assigned.get(String(course._id)) || null;
    return { ...course, access: { assigned: Boolean(status), videos: Boolean(status) && !course.payment.required, status } };
  }) });
});
export const getCourse = asyncHandler(async (req, res) => {
  const identifiers = [{ slug: req.params.id }];
  if (mongoose.isValidObjectId(req.params.id)) identifiers.unshift({ _id: req.params.id });
  const course = await Course.findOne({ $or: identifiers }).populate("instructor", "name avatar bio").populate("category", "name slug");
  if (!course) throw new ApiError(404, "Course not found");
  if (course.archivedAt) throw new ApiError(410, "This course has been archived and is unavailable.");
  if (managesCourse(course, req.user)) {
    return new ApiResponse(res, 200, "Course retrieved", { course, modules: await courseCurriculum(course._id), access: { assigned: true, videos: true } });
  }
  if (req.user.role !== "student" || !course.isPublished) throw new ApiError(403, "This course is not assigned to your account or is not published.");
  const assigned = Boolean(await Enrollment.exists({ student: req.user._id, course: course._id, assignedBy: { $exists: true } }));
  if (!assigned) {
    return new ApiResponse(res, 200, "Course retrieved", { course, modules: catalogOutline(await courseCurriculum(course._id)), access: { assigned: false, videos: false } });
  }
  await requireCourseAccess(course._id, req.user);
  const modules = await courseCurriculum(course._id);
  for (const module of modules) module.lessons = module.lessons.filter((lesson) => lesson.contentType === "text" || lesson.video?.status === "ready");
  return new ApiResponse(res, 200, "Course retrieved", { course, modules, access: { assigned: true, videos: true } });
});
export const myCourses = asyncHandler(async (req, res) => {
  const filter = { ...(req.user.role === "admin" ? {} : { instructor: req.user._id }), archivedAt: req.query.archived === "true" ? { $ne: null } : null };
  const courses = await Course.find(filter).populate("category", "name slug").sort("-updatedAt");
  return new ApiResponse(res, 200, "Instructor courses retrieved", { courses });
});
export const adminCourses = asyncHandler(async (req, res) => {
  const courses = await Course.find().populate("instructor", "name email").populate("category", "name slug").sort("-updatedAt");
  return new ApiResponse(res, 200, "All courses retrieved", { courses });
});
export const getMyCourse = asyncHandler(async (req, res) => {
  const course = await requireCourseOwner(req.params.id, req.user, { allowArchived: true });
  await course.populate("category", "name slug");
  return new ApiResponse(res, 200, "Instructor course retrieved", { course, modules: await courseCurriculum(course._id) });
});
export const createCourse = asyncHandler(async (req, res) => {
  await ensureCategory(req.body.category);
  const course = await Course.create({ ...pickCourseFields(req.body), instructor: req.user._id });
  if (req.body.setupLessons === true) await Module.create({ course: course._id, title: "Lessons", order: 0 });
  return new ApiResponse(res, 201, "Course created. Add content, then assign it to students.", { course });
});
export const updateCourse = asyncHandler(async (req, res) => {
  const course = await requireCourseOwner(req.params.id, req.user);
  const changes = pickCourseFields(req.body);
  if (changes.category) await ensureCategory(changes.category);
  Object.assign(course, changes); await course.save();
  return new ApiResponse(res, 200, "Course updated", { course });
});
export const deleteCourse = asyncHandler(async (req, res) => {
  const course = await requireCourseOwner(req.params.id, req.user, { allowArchived: true });
  await archiveCourse(course, req.user);
  res.locals.auditAction = "course.archived"; res.locals.auditTarget = String(course._id);
  return new ApiResponse(res, 200, "Course archived. Student access is removed; lessons, assignments and progress are retained.", {});
});
export const restoreArchivedCourse = asyncHandler(async (req, res) => {
  const course = await requireCourseOwner(req.params.id, req.user, { allowArchived: true });
  await restoreCourse(course);
  res.locals.auditAction = "course.restored"; res.locals.auditTarget = String(course._id);
  return new ApiResponse(res, 200, "Course restored as a draft. Review its content and publish when ready.", {});
});
export const setPublished = asyncHandler(async (req, res) => {
  const course = await requireCourseOwner(req.params.id, req.user);
  if (req.body.published) {
    await ensureCourseReady(course._id);
  }
  // A publish racing with archive must never reopen access.
  const updated = await Course.findOneAndUpdate({ _id: course._id, archivedAt: null, instructor: course.instructor }, { $set: { isPublished: req.body.published }, ...(req.body.published ? { $set: { isPublished: true, publishedAt: new Date() } } : { $unset: { publishedAt: 1 } }) }, { new: true });
  if (!updated) throw new ApiError(409, "Course access changed. Refresh before publishing.");
  return new ApiResponse(res, 200, updated.isPublished ? "Course published" : "Course unpublished", { course: updated });
});
export const addModule = asyncHandler(async (req, res) => { const course = await requireCourseOwner(req.params.id, req.user); const last = await Module.findOne({ course: course._id }).sort("-order"); const count = last ? last.order + 1 : 0; const module = await Module.create({ course: course._id, title: req.body.title, order: req.body.order ?? count }); return new ApiResponse(res, 201, "Module added", { module }); });
export const updateModule = asyncHandler(async (req, res) => { const module = await Module.findById(req.params.moduleId); if (!module || module.course.toString() !== req.params.id) throw new ApiError(404, "Module not found"); await requireCourseOwner(req.params.id, req.user); if (req.body.title !== undefined) module.title = req.body.title; if (req.body.order !== undefined) module.order = req.body.order; await module.save(); return new ApiResponse(res, 200, "Module updated", { module }); });
export const deleteModule = asyncHandler(async (req, res) => { const module = await Module.findById(req.params.moduleId); if (!module || module.course.toString() !== req.params.id) throw new ApiError(404, "Module not found"); await requireCourseOwner(req.params.id, req.user); const lessons = await Lesson.find({ module: module._id }).select("_id"); await VideoAsset.updateMany({ lesson: { $in: lessons.map((l) => l._id) } }, { status: "cancelled" }); await Lesson.deleteMany({ module: module._id }); await module.deleteOne(); return new ApiResponse(res, 200, "Module and its lessons deleted", {}); });
export const addLesson = asyncHandler(async (req, res) => { const module = await Module.findById(req.params.moduleId); if (!module || module.course.toString() !== req.params.id) throw new ApiError(404, "Module not found"); await requireCourseOwner(req.params.id, req.user); const last = await Lesson.findOne({ module: module._id }).sort("-order"); const count = last ? last.order + 1 : 0; const lesson = await Lesson.create({ title: req.body.title, contentType: req.body.contentType || "video", content: req.body.content || "", course: module.course, module: module._id, order: req.body.order ?? count }); return new ApiResponse(res, 201, "Lesson added", { lesson }); });
export const updateLesson = asyncHandler(async (req, res) => { const lesson = await Lesson.findById(req.params.lessonId); if (!lesson || lesson.course.toString() !== req.params.id) throw new ApiError(404, "Lesson not found"); await requireCourseOwner(req.params.id, req.user); const fields = ["title", "contentType", "content", "duration", "order", "isPreview"]; fields.forEach((field) => { if (req.body[field] !== undefined) lesson[field] = req.body[field]; }); await lesson.save(); return new ApiResponse(res, 200, "Lesson updated", { lesson }); });
export const deleteLesson = asyncHandler(async (req, res) => { const lesson = await Lesson.findById(req.params.lessonId); if (!lesson || lesson.course.toString() !== req.params.id) throw new ApiError(404, "Lesson not found"); await requireCourseOwner(req.params.id, req.user); await VideoAsset.updateMany({ lesson: lesson._id }, { status: "cancelled" }); await lesson.deleteOne(); return new ApiResponse(res, 200, "Lesson deleted", {}); });
