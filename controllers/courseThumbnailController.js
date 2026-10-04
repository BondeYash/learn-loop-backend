import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import Course from "../models/Course.js";
import ApiResponse from "../utils/ApiResponse.js";
import ApiError from "../utils/ApiError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { requireCourseOwner } from "../services/courseService.js";
import { managesCourse } from "../services/courseAccess.js";
import { prepareThumbnail, courseThumbnailStore } from "../services/courseThumbnailStore.js";

export const ownThumbnailCourse = asyncHandler(async (req, _res, next) => { req.thumbnailCourse = await requireCourseOwner(req.params.id, req.user); next(); });
export const uploadThumbnail = asyncHandler(async (req, res) => {
  req.thumbnailProcessing = true;
  try {
  if (!req.file) throw new ApiError(400, "A thumbnail image is required.");
  const course = req.thumbnailCourse;
  const image = await prepareThumbnail(req.file.buffer);
  const version = randomUUID();
  const thumbnail = { url: `/api/courses/${course._id}/thumbnail?v=${version}`, objectKey: `thumbnails/${course._id}/${version}.webp`, storageBucket: process.env.R2_BUCKET, size: image.bytes.length, width: image.width, height: image.height };
  try { await (req.app.locals.courseThumbnailStore || courseThumbnailStore()).upload(thumbnail, image); }
  catch { throw new ApiError(503, "Image storage is temporarily unavailable. Your previous thumbnail is preserved; retry this upload."); }
  // Do not overwrite a concurrently archived or transferred course. Old images
  // stay in private storage for recovery; this path never purges existing media.
  const updated = await Course.findOneAndUpdate({ _id: course._id, instructor: course.instructor, archivedAt: null }, { $set: { thumbnail } }, { new: true, runValidators: true });
  if (!updated) throw new ApiError(409, "Course ownership or access changed. Refresh before replacing its image.");
  return new ApiResponse(res, 200, "Course thumbnail saved", { course: updated });
  } finally { req.thumbnailProcessing = false; req.releaseThumbnailUpload?.(); }
});
export const readThumbnail = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id).select("+thumbnail.objectKey +thumbnail.storageBucket +thumbnail.size");
  if (!course) throw new ApiError(404, "Course not found");
  // Published covers are visible to every signed-in student. Assignment and
  // payment still gate videos, notes, and progress.
  if (!managesCourse(course, req.user)) {
    if (course.archivedAt) throw new ApiError(410, "This course has been archived and is unavailable.");
    if (req.user.role !== "student" || !course.isPublished) throw new ApiError(403, "This course is not published.");
  }
  if (!course.thumbnail?.objectKey) throw new ApiError(404, "No private thumbnail is available.");
  let stream;
  try { stream = await (req.app.locals.courseThumbnailStore || courseThumbnailStore()).read(course.thumbnail); }
  catch { throw new ApiError(503, "Course image is temporarily unavailable."); }
  res.set({ "Content-Type": "image/webp", "Content-Length": String(course.thumbnail.size), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
  try { await pipeline(stream, res); }
  catch (error) { if (!res.headersSent) throw error; res.destroy(); }
});
