import crypto from "node:crypto";
import mongoose from "mongoose";
import Lesson from "../models/Lesson.js";
import VideoAsset from "../models/VideoAsset.js";
import { requireCourseOwner } from "../services/courseService.js";
import { requireCourseAccess } from "../services/courseAccess.js";
import { maxVideoBytes } from "../services/videoStorage.js";
import { directVideoStore } from "../services/directVideoStore.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import { publicVideo } from "./videoController.js";
const store = (req) => req.app.locals.directVideoStore || directVideoStore();
async function owned(req) {
  const asset = await VideoAsset.findById(req.params.id);
  if (!asset || asset.uploadMode !== "direct") throw new ApiError(404, "Direct upload not found");
  await requireCourseOwner(asset.course, req.user);
  if (!await Lesson.exists({ _id: asset.lesson, video: asset._id })) throw new ApiError(410, "This upload is no longer attached to the lesson");
  return asset;
}
function active(asset) {
  if (asset.status === "cancelled" || asset.expiresAt < new Date()) throw new ApiError(410, "Upload expired or removed. Remove the upload entry and select the file again.");
}
export const createDirectUpload = asyncHandler(async (req, res) => {
  if (!process.env.R2_BUCKET && !req.app.locals.directVideoStore) throw new ApiError(503, "Private R2 storage is not configured.");
  const lesson = await Lesson.findById(req.params.lessonId);
  if (!lesson) throw new ApiError(404, "Lesson not found");
  await requireCourseOwner(lesson.course, req.user);
  if (lesson.contentType !== "video") throw new ApiError(400, "Choose a video lesson");
  const { filename, size, fingerprint, duration, width, height } = req.body;
  if (typeof filename !== "string" || filename.length > 200 || !/\.mp4$/i.test(filename) || !/^[a-f0-9]{64}$/.test(fingerprint || "")) throw new ApiError(400, "Upload a browser-compatible H.264/AAC MP4. Convert WebM or MOV before uploading.");
  if (!Number.isSafeInteger(size) || size < 16 || size > maxVideoBytes()) throw new ApiError(400, "Choose an MP4 up to 2 GB.");
  if (!Number.isFinite(duration) || duration <= 0 || duration > 14400 || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192) throw new ApiError(400, "The browser must confirm a playable video up to four hours before upload.");
  const current = lesson.video && await VideoAsset.findById(lesson.video);
  if (current && (current.fingerprint !== fingerprint || current.uploadMode !== "direct")) throw new ApiError(409, "Remove the current video before selecting a different MP4.");
  if (!current && await VideoAsset.countDocuments({ owner: req.user._id, status: { $in: ["uploading", "verifying", "queued", "processing"] } }) >= 3) throw new ApiError(429, "Finish or remove an existing upload first (maximum three unfinished uploads).");
  const id = new mongoose.Types.ObjectId();
  const asset = await VideoAsset.findOneAndUpdate({ lesson: lesson._id, fingerprint }, { $setOnInsert: { _id: id, owner: req.user._id, course: lesson.course, filename, size, duration, width, height, uploadMode: "direct", storageProvider: "r2", storageBucket: process.env.R2_BUCKET, uploadKey: `incoming/${id}/${crypto.randomUUID()}.mp4`, chunkSize: 0, chunkCount: 0, expiresAt: new Date(Date.now() + 86400000) } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  if (asset.status !== "ready") active(asset);
  const linked = await Lesson.updateOne({ _id: lesson._id, $or: [{ video: null }, { video: asset._id }] }, { video: asset._id });
  if (!linked.matchedCount) { await VideoAsset.updateOne({ _id: asset._id }, { status: "cancelled" }); throw new ApiError(409, "Another video was attached. Refresh this lesson."); }
  return new ApiResponse(res, 200, "Direct upload session ready", { video: publicVideo(asset) });
});
export const directUploadTicket = asyncHandler(async (req, res) => {
  const asset = await owned(req); active(asset);
  if (!["uploading", "failed"].includes(asset.status)) throw new ApiError(409, "This upload is already being checked or is ready.");
  const updated = await VideoAsset.updateOne({ _id: asset._id, status: { $in: ["uploading", "failed"] } }, { status: "uploading", error: "" });
  if (!updated.matchedCount) throw new ApiError(409, "The upload is already being checked. Refresh the lesson.");
  return new ApiResponse(res, 200, "Temporary upload link issued", await store(req).uploadTicket(asset));
});
export const completeDirectUpload = asyncHandler(async (req, res) => {
  const asset = await owned(req);
  if (asset.status === "ready") return new ApiResponse(res, 200, "Video ready", { video: publicVideo(asset) });
  active(asset);
  const token = crypto.randomUUID();
  const claimed = await VideoAsset.findOneAndUpdate({ _id: asset._id, $or: [{ status: { $in: ["uploading", "failed"] } }, { status: "verifying", leaseUntil: { $lt: new Date() } }] }, { status: "verifying", processingToken: token, leaseUntil: new Date(Date.now() + 120000), error: "" }, { new: true });
  if (!claimed) throw new ApiError(409, "This upload is being checked. Retry the check shortly.");
  const objectKey = `videos/${asset._id}/${token}.mp4`;
  try {
    const result = await store(req).finalize(claimed, objectKey);
    if (!await Lesson.exists({ _id: asset.lesson, video: asset._id })) throw new ApiError(410, "Video was removed while the upload was checked.");
    const ready = await VideoAsset.findOneAndUpdate({ _id: asset._id, status: "verifying", processingToken: token }, { status: "ready", objectKey, outputSize: result.outputSize, error: "" }, { new: true });
    if (!ready) throw new ApiError(409, "Upload state changed. Refresh the lesson.");
    await Lesson.updateOne({ _id: asset.lesson, video: asset._id }, { duration: asset.duration });
    await store(req).cleanupIncoming(ready).catch(() => {});
    return new ApiResponse(res, 200, "Video ready", { video: publicVideo(ready) });
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Could not verify the uploaded MP4. Check the upload again; if it fails, select the same file to retry.";
    await VideoAsset.updateOne({ _id: asset._id, status: "verifying", processingToken: token }, { status: "failed", error: message });
    throw error instanceof ApiError ? error : new ApiError(503, message);
  }
});
export const playbackTicket = asyncHandler(async (req, res) => {
  const lesson = await Lesson.findById(req.params.lessonId);
  if (!lesson) throw new ApiError(404, "Lesson not found");
  await requireCourseAccess(lesson.course, req.user);
  const asset = lesson.video && await VideoAsset.findById(lesson.video);
  if (!asset || asset.status !== "ready") throw new ApiError(409, "This video is not ready.");
  if (asset.storageProvider !== "r2" || !asset.objectKey) throw new ApiError(409, "This older local video must be migrated to private R2 before direct playback.");
  return new ApiResponse(res, 200, "Temporary playback link issued", await store(req).playback(asset));
});
