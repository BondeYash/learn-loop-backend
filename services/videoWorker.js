import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { mkdir, rm, stat } from "node:fs/promises";
import { persistVideo, deleteStoredVideo } from "./videoObjectStore.js";
import VideoAsset from "../models/VideoAsset.js";
import Lesson from "../models/Lesson.js";
import { assetDir, assemble, outputPath, publishOutput, chunkPath, storageRoot } from "./videoStorage.js";
const activeCommands = new Set();
export function runMediaCommand(command, args, timeout = 60_000, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Processing cancelled"));
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.once("close", () => signal?.removeEventListener("abort", abort));
    activeCommands.add(child);
    child.once("close", () => activeCommands.delete(child));
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout = (stdout + d).slice(-1024 * 1024); });
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(stdout); else reject(new Error(`Media processing failed (${code}): ${stderr}`)); });
  });
}
export async function checkVideoTools() {
  await mkdir(storageRoot(), { recursive: true });
  await runMediaCommand(process.env.FFMPEG_PATH || "ffmpeg", ["-version"]);
  await runMediaCommand(process.env.FFPROBE_PATH || "ffprobe", ["-version"]);
}
export async function processNextVideo() {
  const token = crypto.randomUUID();
  const asset = await VideoAsset.findOneAndUpdate({ uploadMode: { $ne: "direct" }, $or: [{ status: "queued" }, { status: "processing", leaseUntil: { $lt: new Date() } }] },
    { status: "processing", processingToken: token, leaseUntil: new Date(Date.now() + 90_000), error: "" }, { new: true, sort: { createdAt: 1 } });
  if (!asset) return false;
  const cancellation = new AbortController();
  const heartbeat = setInterval(async () => {
    try {
      const result = await VideoAsset.updateOne({ _id: asset._id, processingToken: token, status: "processing" }, { leaseUntil: new Date(Date.now() + 90_000) });
      if (!result.matchedCount) cancellation.abort();
    } catch (error) { console.error("Video lease renewal failed:", error.name); cancellation.abort(); }
  }, 5000);
  const input = path.join(assetDir(asset._id), `${token}.input`);
  const temporary = path.join(assetDir(asset._id), `${token}.tmp.mp4`);
  try {
    await assemble(asset, input);
    const metadata = JSON.parse(await runMediaCommand(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_format", "-show_streams", "-of", "json", input]));
    const formats = (metadata.format?.format_name || "").split(",");
    const video = metadata.streams?.find((stream) => stream.codec_type === "video");
    const duration = Number(metadata.format?.duration);
    if (!formats.some((f) => ["mov", "mp4", "matroska", "webm"].includes(f)) || !video || !Number.isFinite(duration) || duration <= 0 || duration > 4 * 60 * 60 || video.width > 8192 || video.height > 8192) {
      throw new Error("Unsupported media");
    }
    await runMediaCommand(process.env.FFMPEG_PATH || "ffmpeg", ["-nostdin", "-y", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", input,
      "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-map_metadata", "-1", "-vf", "fps=30,scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-t", String(duration), temporary], 4 * 60 * 60 * 1000, cancellation.signal);
    const outputSize = (await stat(temporary)).size;
    await publishOutput(temporary, outputPath(asset));
    if (!await VideoAsset.exists({ _id: asset._id, processingToken: token, status: "processing" })) return true;
    asset.objectKey = `videos/${asset._id}/video.mp4`;
    await VideoAsset.updateOne({ _id: asset._id, processingToken: token }, { objectKey: asset.objectKey });
    await persistVideo(asset);
    const saved = await VideoAsset.updateOne({ _id: asset._id, processingToken: token, status: "processing" }, { status: "ready", duration, outputSize, error: "" });
    if (saved.modifiedCount) {
      if (asset.storageProvider === "r2") await rm(outputPath(asset), { force: true });
      await Lesson.updateOne({ _id: asset.lesson, video: asset._id }, { duration });
      await Promise.all(Array.from({ length: asset.chunkCount }, (_, i) => Promise.all([rm(chunkPath(asset._id, i), { force: true }), rm(`${chunkPath(asset._id, i)}.sha256`, { force: true })])));
    } else await rm(outputPath(asset), { force: true });
  } catch (error) {
    console.error(`Video ${asset._id} processing failed:`, error.message);
    await VideoAsset.updateOne({ _id: asset._id, processingToken: token, status: "processing" }, { status: "failed", error: "Video processing failed. Retry processing, or remove it and upload a valid MP4, MOV, or WebM video (up to 4 hours)." });
  } finally {
    clearInterval(heartbeat);
    await Promise.all([rm(input, { force: true }), rm(temporary, { force: true })]);
  }
  return true;
}
export async function cleanupVideos() {
  const expired = await VideoAsset.find({ uploadMode: { $ne: "direct" }, $or: [{ status: { $in: ["uploading", "failed"] }, expiresAt: { $lt: new Date() } }, { status: "cancelled", cleanedAt: { $exists: false }, updatedAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } }] }).limit(50);
  for (const asset of expired) {
    const claimed = await VideoAsset.updateOne({ _id: asset._id, status: asset.status }, { status: "cancelled", error: "Upload expired. Remove it and select the file again." });
    if (!claimed.matchedCount) continue;
    await deleteStoredVideo(asset);
    await rm(assetDir(asset._id), { recursive: true, force: true });
    await VideoAsset.updateOne({ _id: asset._id, status: "cancelled" }, { cleanedAt: new Date() });
  }
}
export function startVideoWorker() {
  let busy = false;
  let ticks = 0;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await processNextVideo(); if (++ticks % 30 === 0) await cleanupVideos(); }
    catch (error) { console.error("Video worker:", error.message); }
    finally { busy = false; }
  }, 2000);
  return () => { clearInterval(timer); for (const child of activeCommands) child.kill("SIGTERM"); };
}
