import mongoose from "mongoose";
import Course from "../models/Course.js";
import Lesson from "../models/Lesson.js";
import Module from "../models/Module.js";
import ApiError from "../utils/ApiError.js";
import { rupeesToMinor } from "./coursePricing.js";

export const publicCourseFields = ["visibility", "examName", "summary", "audience", "publicInstructorName", "publicInstructorBio", "supportEmail", "supportUrl", "termsUrl", "privacyPolicyUrl", "refundPolicyUrl", "previewLesson"];
export const publicCourseFilter = { visibility: "public", isPublished: true, archivedAt: null };
export const publicCourseSelection = "title slug description category thumbnail.url price language level requirements learningOutcomes publishedAt " + publicCourseFields.join(" ");
export function safePublicUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }
  catch { return false; }
}
export async function validatePublicCourseChanges(course, changes) {
  if (!changes.previewLesson) return;
  const lesson = await Lesson.findOne({ _id: changes.previewLesson, course: course._id }).populate("video", "status storageProvider objectKey course lesson");
  if (!lesson || !["text", "video"].includes(lesson.contentType)) throw new ApiError(400, "Choose a text or video sample lesson from this course.");
  if (lesson.contentType === "text" && !lesson.content.trim()) throw new ApiError(400, "Add sample lesson text before choosing it as a public preview.");
  if (lesson.contentType === "video" && (lesson.video?.status !== "ready" || lesson.video.storageProvider !== "r2" || !lesson.video.objectKey || String(lesson.video.course) !== String(course._id) || String(lesson.video.lesson) !== String(lesson._id))) throw new ApiError(400, "Finish this lesson's private video upload before choosing it as a public preview.");
}
export async function findPublicCourse(identifier, extraSelection = "") {
  if (typeof identifier !== "string" || identifier.length > 240) throw new ApiError(404, "Public course not found.");
  const identifiers = [{ slug: identifier }];
  if (mongoose.isValidObjectId(identifier)) identifiers.unshift({ _id: identifier });
  const course = await Course.findOne({ ...publicCourseFilter, $or: identifiers }).select(publicCourseSelection + " " + extraSelection).populate("category", "name slug");
  if (!course) throw new ApiError(404, "Public course not found.");
  return course;
}
export function publicCourseCard(course) {
  // Explicit DTO: account/profile fields, private object keys and unpublished
  // lesson content are never inherited from a populated document.
  const thumbnailUrl = course.thumbnail?.url || "";
  return { id: String(course._id), title: course.title, slug: course.slug, summary: course.summary || "", examName: course.examName || "", language: course.language, level: course.level, amountMinor: rupeesToMinor(course.price || 0), currency: "inr", category: course.category ? { id: String(course.category._id), name: course.category.name, slug: course.category.slug } : null, thumbnail: { url: thumbnailUrl.startsWith("/api/courses/") ? `/api/public/courses/${course._id}/thumbnail` : safePublicUrl(thumbnailUrl) ? thumbnailUrl : "" }, instructorName: course.publicInstructorName || "", hasPreview: Boolean(course.previewLesson) };
}
export async function publicOutline(course) {
  const [modules, lessons] = await Promise.all([Module.find({ course: course._id }).select("title order").sort("order").lean(), Lesson.find({ course: course._id }).select("title module order contentType duration").sort("order").lean()]);
  return modules.map((module) => ({ title: module.title, lessons: lessons.filter((lesson) => String(lesson.module) === String(module._id)).map((lesson) => ({ title: lesson.title, contentType: lesson.contentType, duration: lesson.duration, preview: String(lesson._id) === String(course.previewLesson) })) }));
}
export async function selectedPublicPreview(course) {
  if (!course.previewLesson) throw new ApiError(404, "No sample lesson has been provided for this course.");
  const lesson = await Lesson.findOne({ _id: course.previewLesson, course: course._id }).populate("video");
  if (!lesson || !["text", "video"].includes(lesson.contentType)) throw new ApiError(404, "This sample lesson is unavailable.");
  if (lesson.contentType === "text" && !lesson.content.trim()) throw new ApiError(404, "This sample lesson is unavailable.");
  if (lesson.contentType === "video" && (lesson.video?.status !== "ready" || lesson.video.storageProvider !== "r2" || !lesson.video.objectKey || String(lesson.video.course) !== String(course._id) || String(lesson.video.lesson) !== String(lesson._id))) throw new ApiError(404, "This sample video is unavailable.");
  return lesson;
}
