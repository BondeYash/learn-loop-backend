import { stat } from "node:fs/promises";
import Lesson from "../models/Lesson.js";
import VideoAsset from "../models/VideoAsset.js";
import { requireCourseOwner } from "../services/courseService.js";
import { requireCourseAccess } from "../services/courseAccess.js";
import { findSession } from "../middleware/auth.js";
import { CHUNK_SIZE, maxVideoBytes, listChunks, storeChunk, outputPath, parseRange, chunkPath, hashFile } from "../services/videoStorage.js";
import { storageProvider, openVideo } from "../services/videoObjectStore.js";
import ApiError from "../utils/ApiError.js";
import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";
export const publicVideo = (asset) => asset && ({ _id: asset._id, status: asset.status, error: asset.error, filename: asset.filename, size: asset.size, chunkSize: asset.chunkSize, chunkCount: asset.chunkCount, duration: asset.duration, uploadMode: asset.uploadMode });
async function ownedAsset(req) {
  const asset = await VideoAsset.findById(req.params.id);
  if (!asset) throw new ApiError(404, "Upload not found");
  await requireCourseOwner(asset.course, req.user);
  return asset;
}
export const createUpload = asyncHandler(async (req, res) => {
  if (process.env.ENABLE_LEGACY_VIDEO_WORKER !== "true" && process.env.NODE_ENV !== "test") throw new ApiError(410, "Server conversion is disabled. Refresh the app and upload a preconverted MP4 directly to R2.");
  const lesson = await Lesson.findById(req.params.lessonId);
  if (!lesson) throw new ApiError(404, "Lesson not found");
  await requireCourseOwner(lesson.course, req.user);
  if (lesson.contentType !== "video") throw new ApiError(400, "Choose a video lesson");
  const { filename, size, fingerprint } = req.body;
  if (!Number.isSafeInteger(size) || size < 1 || size > maxVideoBytes()) throw new ApiError(400, `Video must be between 1 byte and ${maxVideoBytes()} bytes`);
  if (typeof filename !== "string" || filename.length > 200 || !/\.(mp4|mov|webm)$/i.test(filename) || !/^[a-f0-9]{64}$/.test(fingerprint || "")) throw new ApiError(400, "Select an MP4, MOV, or WebM video");
  const current = lesson.video && await VideoAsset.findById(lesson.video);
  if (current && current.fingerprint !== fingerprint) throw new ApiError(409, "Remove the current video before uploading a different file");
  if (!current && await VideoAsset.countDocuments({ owner: req.user._id, status: { $in: ["uploading", "queued", "processing"] } }) >= 3) throw new ApiError(429, "Finish or remove an existing upload before starting another (maximum 3).");
  const asset = await VideoAsset.findOneAndUpdate({ lesson: lesson._id, fingerprint }, { $setOnInsert: { owner: req.user._id, course: lesson.course, filename, size, checksumVersion: 1, storageProvider: storageProvider(), storageBucket: storageProvider() === "r2" ? process.env.R2_BUCKET : undefined, chunkSize: CHUNK_SIZE, chunkCount: Math.ceil(size / CHUNK_SIZE), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  if (asset.status === "cancelled") throw new ApiError(410, "Upload expired or removed. Select the file again after removing this upload.");
  const linked = await Lesson.updateOne({ _id: lesson._id, $or: [{ video: null }, { video: asset._id }] }, { video: asset._id });
  if (!linked.matchedCount) { await VideoAsset.updateOne({ _id: asset._id }, { status: "cancelled" }); throw new ApiError(409, "Another video was attached to this lesson. Refresh the page."); }
  return new ApiResponse(res, 200, "Upload session ready", { video: publicVideo(asset), uploadedChunks: asset.uploadMode === "direct" ? [] : await listChunks(asset) });
});
export const uploadStatus = asyncHandler(async (req, res) => { const asset = await ownedAsset(req); return new ApiResponse(res, 200, "Upload status", { video: publicVideo(asset), uploadedChunks: asset.uploadMode === "direct" ? [] : await listChunks(asset) }); });
export const uploadChunk = asyncHandler(async (req, res) => {
  const asset = await ownedAsset(req);
  if (asset.uploadMode === "direct") throw new ApiError(409, "Use the direct upload flow for this video.");
  if (asset.status !== "uploading") throw new ApiError(409, "This upload no longer accepts chunks");
  if (asset.expiresAt < new Date()) throw new ApiError(410, "Upload expired; remove it and start again");
  await storeChunk(asset, Number(req.params.index), req.headers["x-chunk-sha256"], req);
  return new ApiResponse(res, 200, "Chunk saved", {});
});
export const verifyChunk = asyncHandler(async (req, res) => {
  const asset = await ownedAsset(req);
  if (asset.uploadMode === "direct") throw new ApiError(409, "Use the direct upload flow for this video.");
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0 || index >= asset.chunkCount) throw new ApiError(400, "Invalid chunk index");
  const digest = await hashFile(chunkPath(asset._id, index)).catch(() => null);
  if (!digest || digest !== req.body.digest) throw new ApiError(409, "Saved chunk differs. Select the original file or remove this upload.");
  return new ApiResponse(res, 200, "Saved chunk verified", {});
});
export const completeUpload = asyncHandler(async (req, res) => {
  const asset = await ownedAsset(req);
  if (asset.uploadMode === "direct") throw new ApiError(409, "Use the direct upload completion endpoint for this video.");
  if (["ready", "queued", "processing"].includes(asset.status)) return new ApiResponse(res, 200, "Video is already submitted", { video: publicVideo(asset) });
  if (asset.status === "cancelled" || asset.expiresAt < new Date()) throw new ApiError(410, "Upload expired; remove it and start again");
  const chunks = await listChunks(asset);
  if (chunks.length !== asset.chunkCount || chunks.some((chunk, index) => chunk !== index)) throw new ApiError(409, "Upload is incomplete. Select the same file to resume.");
  const updated = await VideoAsset.findOneAndUpdate({ _id: asset._id, status: { $in: ["uploading", "failed"] } }, { status: "queued", error: "" }, { new: true });
  return new ApiResponse(res, 202, "Video queued for processing", { video: publicVideo(updated || asset) });
});
export const removeUpload = asyncHandler(async (req, res) => {
  const asset = await ownedAsset(req);
  await Lesson.updateOne({ _id: asset.lesson, video: asset._id }, { video: null, duration: 0 });
  // Change the fingerprint to permit a fresh upload of the same file after removal.
  await VideoAsset.updateOne({ _id: asset._id }, { status: "cancelled", fingerprint: `removed-${asset._id}` });
  return new ApiResponse(res, 200, "Video removed", {});
});
export const streamVideo = asyncHandler(async (req, res) => {
  const lesson = await Lesson.findById(req.params.lessonId);
  if (!lesson) throw new ApiError(404, "Lesson not found");
  await requireCourseAccess(lesson.course, req.user);
  const asset = lesson.video && await VideoAsset.findById(lesson.video);
  if (!asset || asset.status !== "ready") throw new ApiError(409, "This video is not ready for playback");
  let size;
  try { size = asset.storageProvider === "r2" ? asset.outputSize : (await stat(outputPath(asset))).size; } catch { throw new ApiError(503, "Video storage is temporarily unavailable. Please retry."); }
  const range = parseRange(req.headers.range, size);
  res.set({ "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
  if (range === false) return res.status(416).set("Content-Range", `bytes */${size}`).end();
  const start = range?.start || 0;
  const end = range?.end ?? size - 1;
  let stream;
  if (req.method !== "HEAD") { try { stream = await openVideo(asset, range || null); } catch { throw new ApiError(503, "Video storage is temporarily unavailable. Please retry."); } }
  res.status(range ? 206 : 200).set("Content-Length", String(end - start + 1));
  if (range) res.set("Content-Range", `bytes ${start}-${end}/${size}`);
  if (req.method === "HEAD") return res.end();
  let checking = false;
  const check = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const session = await findSession(req);
      if (!session) throw new Error("Session ended");
      await requireCourseAccess(lesson.course, session.user);
      const [stillAttached, stillReady] = await Promise.all([Lesson.exists({ _id: lesson._id, video: asset._id }), VideoAsset.exists({ _id: asset._id, status: "ready" })]);
      if (!stillAttached || !stillReady) throw new Error("Video removed");
    }
    catch { stream.destroy(); res.destroy(); }
    finally { checking = false; }
  }, 5000);
  res.on("close", () => { clearInterval(check); stream.destroy(); });
  stream.on("error", () => { clearInterval(check); res.destroy(); });
  stream.pipe(res);
});
