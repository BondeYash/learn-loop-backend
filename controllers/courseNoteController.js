import crypto from "node:crypto";
import mongoose from "mongoose";
import CourseNote from "../models/CourseNote.js";
import { requireCourseOwner } from "../services/courseService.js";
import { requireCourseAccess, managesCourse } from "../services/courseAccess.js";
import { safePdfName, validatePdf } from "../services/pdfValidation.js";
import { courseNoteStore } from "../services/courseNoteStore.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";

const store = (req) => req.app.locals.courseNoteStore || courseNoteStore();
const publicNote = (note) => ({ id: note._id, filename: note.filename, size: note.size, pages: note.pages, status: note.status, createdAt: note.createdAt });
export const ownNoteCourse = asyncHandler(async (req, res, next) => { req.noteCourse = await requireCourseOwner(req.params.id, req.user); next(); });
export const listNotes = asyncHandler(async (req, res) => {
  const course = await requireCourseAccess(req.params.id, req.user);
  const notes = await CourseNote.find({ course: course._id, ...(managesCourse(course, req.user) ? {} : { status: "ready" }) }).sort("createdAt");
  return new ApiResponse(res, 200, "Course notes", { notes: notes.map(publicNote) });
});
export const uploadNote = asyncHandler(async (req, res) => {
  if (!process.env.R2_BUCKET && !req.app.locals.courseNoteStore) throw new ApiError(503, "Private note storage is not configured.");
  if (!req.file) throw new ApiError(400, "Choose a PDF file.");
  const uploadId = req.body.uploadId;
  if (typeof uploadId !== "string" || !/^[a-f0-9-]{36}$/i.test(uploadId)) throw new ApiError(400, "A valid upload identifier is required.");
  const hash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
  let note = await CourseNote.findOne({ course: req.params.id, uploadId });
  if (note && note.sha256 !== hash) throw new ApiError(409, "Select this file again to start a new upload.");
  if (note?.status === "ready") return new ApiResponse(res, 200, "PDF already uploaded", { note: publicNote(note) });
  const pages = await validatePdf(req.file.buffer);
  const leaseUntil = new Date(Date.now() + 90000);
  if (note) {
    note = await CourseNote.findOneAndUpdate({ _id: note._id, $or: [{ status: "failed" }, { status: "uploading", leaseUntil: { $lt: new Date() } }] }, { status: "uploading", leaseUntil }, { new: true });
    if (!note) throw new ApiError(409, "This PDF is still uploading or being removed. Refresh the notes before retrying.");
  } else {
    for (let slot = 0; slot < 20; slot++) {
      const id = new mongoose.Types.ObjectId();
      try {
        note = await CourseNote.create({ _id: id, course: req.params.id, owner: req.user._id, slot, uploadId, filename: safePdfName(req.file.originalname), size: req.file.size, sha256: hash, pages, storageBucket: process.env.R2_BUCKET, objectKey: `notes/${req.params.id}/${id}.pdf`, leaseUntil });
        break;
      } catch (error) {
        if (error.code !== 11000) throw error;
        if (await CourseNote.exists({ course: req.params.id, uploadId })) throw new ApiError(409, "This PDF is already uploading. Refresh the notes before retrying.");
      }
    }
    if (!note) throw new ApiError(409, "This course already has 20 notes. Remove a note before adding another.");
  }
  try {
    await store(req).upload(note, req.file.buffer);
    // Recheck after storage work; an archived/transferred course must not become available here.
    await requireCourseOwner(req.params.id, req.user);
    const ready = await CourseNote.findOneAndUpdate({ _id: note._id, status: "uploading", leaseUntil }, { status: "ready", $unset: { leaseUntil: 1 } }, { new: true });
    if (!ready) throw new ApiError(409, "The note changed during upload. Refresh the course.");
    res.locals.auditAction = "course.note-uploaded"; res.locals.auditTarget = String(note._id);
    return new ApiResponse(res, 201, "PDF uploaded", { note: publicNote(ready) });
  } catch (error) {
    await CourseNote.updateOne({ _id: note._id, status: "uploading", leaseUntil }, { status: "failed" });
    throw error instanceof ApiError ? error : new ApiError(503, "PDF upload could not be confirmed. Retry the same file, or remove the failed entry.");
  }
});
export const noteLink = asyncHandler(async (req, res) => {
  await requireCourseAccess(req.params.id, req.user);
  const note = await CourseNote.findOne({ _id: req.params.noteId, course: req.params.id, status: "ready" });
  if (!note) throw new ApiError(404, "Ready PDF note not found.");
  return new ApiResponse(res, 200, "Temporary PDF link", await store(req).link(note, req.query.download === "true"));
});
export const removeNote = asyncHandler(async (req, res) => {
  const note = await CourseNote.findOneAndUpdate({ _id: req.params.noteId, course: req.params.id, $or: [{ status: { $in: ["ready", "failed", "removing"] } }, { status: "uploading", leaseUntil: { $lt: new Date() } }] }, { status: "removing" }, { new: true });
  if (!note) {
    if (await CourseNote.exists({ _id: req.params.noteId, course: req.params.id })) throw new ApiError(409, "This PDF is still uploading. Wait for it to finish before removing it.");
    return new ApiResponse(res, 200, "PDF removed", {});
  }
  try { await store(req).remove(note); }
  catch { throw new ApiError(503, "The PDF is hidden, but storage removal failed. Retry Remove to finish."); }
  await CourseNote.deleteOne({ _id: note._id, status: "removing" });
  res.locals.auditAction = "course.note-removed"; res.locals.auditTarget = String(note._id);
  return new ApiResponse(res, 200, "PDF removed", {});
});
