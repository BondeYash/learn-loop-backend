import mongoose from "mongoose";
import { pipeline } from "node:stream/promises";
import Course from "../models/Course.js";
import Category from "../models/Category.js";
import ApiResponse from "../utils/ApiResponse.js";
import ApiError from "../utils/ApiError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { publicCourseFilter, publicCourseSelection, findPublicCourse, publicCourseCard, publicOutline, selectedPublicPreview, safePublicUrl } from "../services/publicCatalog.js";
import { directVideoStore } from "../services/directVideoStore.js";
import { courseThumbnailStore } from "../services/courseThumbnailStore.js";

export const listPublicCourses = asyncHandler(async (req, res) => {
  const page = Number(req.query.page || 1), limit = Number(req.query.limit || 12), q = req.query.q || "", category = req.query.category || "";
  if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 50 || typeof q !== "string" || q.length > 100 || typeof category !== "string" || category && !mongoose.isValidObjectId(category)) throw new ApiError(400, "Use a valid search, category and page.");
  const filter = { ...publicCourseFilter, ...(category ? { category } : {}) };
  if (q.trim()) { const pattern = q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); filter.$or = ["title", "examName", "summary"].map((field) => ({ [field]: { $regex: pattern, $options: "i" } })); }
  const [courses, total, categoryIds] = await Promise.all([Course.find(filter).select(publicCourseSelection).populate("category", "name slug").sort({ publishedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit), Course.countDocuments(filter), Course.distinct("category", publicCourseFilter)]);
  const categories = await Category.find({ _id: { $in: categoryIds } }).select("name slug").sort("name").lean();
  return new ApiResponse(res, 200, "Public courses", { courses: courses.map(publicCourseCard), total, page, limit, categories: categories.map((item) => ({ id: String(item._id), name: item.name, slug: item.slug })) });
});
export const getPublicCourse = asyncHandler(async (req, res) => {
  const course = await findPublicCourse(req.params.id);
  const link = (value) => safePublicUrl(value) ? value : "";
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(course.supportEmail || "") ? course.supportEmail : "";
  return new ApiResponse(res, 200, "Public course", { course: { ...publicCourseCard(course), description: course.description, audience: course.audience || "", requirements: course.requirements, learningOutcomes: course.learningOutcomes, instructorBio: course.publicInstructorBio || "", support: { email, url: link(course.supportUrl) }, policies: { terms: link(course.termsUrl), privacy: link(course.privacyPolicyUrl), refund: link(course.refundPolicyUrl) } }, modules: await publicOutline(course) });
});
export const publicPreview = asyncHandler(async (req, res) => {
  const course = await findPublicCourse(req.params.id), lesson = await selectedPublicPreview(course);
  const preview = { title: lesson.title, contentType: lesson.contentType, duration: lesson.duration, ...(lesson.contentType === "text" ? { content: lesson.content } : {}) };
  if (lesson.contentType === "video") {
    try { const { url, expiresAt } = await (req.app.locals.directVideoStore || directVideoStore()).playback(lesson.video); Object.assign(preview, { url, expiresAt }); }
    catch { throw new ApiError(503, "The sample video is temporarily unavailable. Please retry."); }
  }
  if (!await Course.exists({ _id: course._id, ...publicCourseFilter, previewLesson: lesson._id })) throw new ApiError(404, "This sample lesson is unavailable.");
  return new ApiResponse(res, 200, "Sample lesson", { preview });
});
export const publicThumbnail = asyncHandler(async (req, res) => {
  const course = await findPublicCourse(req.params.id, "+thumbnail.objectKey +thumbnail.storageBucket +thumbnail.size");
  if (!course.thumbnail?.objectKey) throw new ApiError(404, "No course image is available.");
  let stream;
  try { stream = await (req.app.locals.courseThumbnailStore || courseThumbnailStore()).read(course.thumbnail); }
  catch { throw new ApiError(503, "The course image is temporarily unavailable."); }
  if (!await Course.exists({ _id: course._id, ...publicCourseFilter })) { stream.destroy(); throw new ApiError(404, "Public course not found."); }
  res.set({ "Content-Type": "image/webp", "Content-Length": String(course.thumbnail.size), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
  try { await pipeline(stream, res); } catch (error) { if (!res.headersSent) throw error; res.destroy(); }
});
