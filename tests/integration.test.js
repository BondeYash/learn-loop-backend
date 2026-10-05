import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm, rename, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import mongoose from "mongoose";
import app from "../app.js";
import User from "../models/User.js";
import Session from "../models/Session.js";
import Course from "../models/Course.js";
import Category from "../models/Category.js";
import Module from "../models/Module.js";
import Lesson from "../models/Lesson.js";
import Enrollment from "../models/Enrollment.js";
import Progress from "../models/Progress.js";
import VideoAsset from "../models/VideoAsset.js";
import { runMediaCommand, processNextVideo } from "../services/videoWorker.js";
import { parseRange, outputPath, storeChunk, assetDir, assemble, chunkPath } from "../services/videoStorage.js";
import { openVideo } from "../services/videoObjectStore.js";
const fixturePassword = crypto.randomBytes(24).toString("base64url");
const digest = (data) => crypto.createHash("sha256").update(data).digest("hex");

test("HTTP byte-range validation", () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  for (const invalid of ["bytes=100-", "bytes=10-2", "bytes=-0", "bytes=0-1,4-5", "bytes=-", "invalid"]) assert.equal(parseRange(invalid, 100), false);
});
test("R2 range request stays server-side (SDK mock, no live R2)", async () => {
  let command;
  const body = {};
  const stream = await openVideo({ storageProvider: "r2", storageBucket: "private", objectKey: "videos/test/video.mp4" }, { start: 10, end: 19 }, { client: { send: async (value) => { command = value; return { Body: body }; } } });
  assert.equal(stream, body);
  assert.deepEqual(command.input, { Bucket: "private", Key: "videos/test/video.mp4", Range: "bytes=10-19" });
});
test("cancelling a running media command terminates its child", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const command = runMediaCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 10_000, controller.signal);
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(command, /Media processing failed/); }
  finally { clearTimeout(timer); }
  assert.ok(Date.now() - started < 5000, "Cancellation must not wait for the command timeout");
});
test("Real MongoDB + HTTP + FFmpeg integration", { timeout: 120_000 }, async (t) => {
  // Never load .env or connect to an external/production database in tests.
  const dbName = `lms_test_${crypto.randomBytes(6).toString("hex")}`;
  process.env.NODE_ENV = "test";
  process.env.CLIENT_URL = "http://localhost:5173";
  process.env.VIDEO_STORAGE_PROVIDER = "local";
  const directory = await mkdtemp(path.join(os.tmpdir(), "lms-video-test-"));
  process.env.VIDEO_STORAGE_DIR = path.join(directory, "videos");
  await mongoose.connect(`mongodb://127.0.0.1:${process.env.TEST_MONGO_PORT || 27018}/${dbName}`, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([User, Session, Course, Category, Module, Lesson, Enrollment, Progress, VideoAsset].map((model) => model.init()));
  const server = await new Promise((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (url, { method = "GET", cookie, body, headers = {} } = {}) => {
    const response = await fetch(base + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(body && !Buffer.isBuffer(body) ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined });
    const bytes = Buffer.from(await response.arrayBuffer());
    let json; try { json = JSON.parse(bytes.toString()); } catch { json = null; }
    return { status: response.status, json, bytes, headers: response.headers, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const register = async (email, role) => {
    if (role === "instructor") await User.create({ email, role, name: role, password: fixturePassword });
    const response = await call(role === "instructor" ? "/auth/login" : "/auth/register", { method: "POST", body: { email, role, name: role, password: fixturePassword } });
    assert.equal(response.status, role === "instructor" ? 200 : 201, JSON.stringify(response.json));
    assert.match(response.headers.get("set-cookie"), /HttpOnly/);
    assert.equal(response.json.data.token, undefined);
    return { cookie: response.cookie, user: response.json.data.user };
  };
  try {
    const teacher = await register("teacher@example.test", "instructor");
    const otherTeacher = await register("other-teacher@example.test", "instructor");
    const student = await register("student@example.test", "student");
    const otherStudent = await register("other-student@example.test", "student");
    await t.test("signup rejects admin escalation, duplicate signup, wrong password, and cross-origin writes", async () => {
      assert.equal((await call("/auth/register", { method: "POST", body: { name: "Admin", email: "admin@example.test", password: fixturePassword, role: "admin" } })).status, 400);
      assert.equal((await call("/auth/register", { method: "POST", body: { name: "Again", email: "student@example.test", password: fixturePassword, role: "student" } })).status, 409);
      assert.equal((await call("/auth/login", { method: "POST", body: { email: "student@example.test", password: "wrong" } })).status, 401);
      assert.equal((await call("/auth/logout", { method: "POST", cookie: student.cookie, headers: { Origin: "https://untrusted.example" } })).status, 403);
      assert.equal((await call("/auth/me", { cookie: student.cookie })).json.data.user.id, student.user.id);
    });
    const category = await Category.create({ name: "General" });
    const courseResponse = await call("/courses", { method: "POST", cookie: teacher.cookie, body: { title: "Video reliability", description: "Integration fixture", category: String(category._id) } });
    assert.equal(courseResponse.status, 201, JSON.stringify(courseResponse.json));
    const courseId = courseResponse.json.data.course._id;
    const moduleResponse = await call(`/courses/${courseId}/modules`, { method: "POST", cookie: teacher.cookie, body: { title: "Module one" } });
    assert.equal(moduleResponse.status, 201);
    const moduleId = moduleResponse.json.data.module._id;
    const lessonResponse = await call(`/courses/${courseId}/modules/${moduleId}/lessons`, { method: "POST", cookie: teacher.cookie, body: { title: "Sample video", contentType: "video", video: new mongoose.Types.ObjectId() } });
    assert.equal(lessonResponse.status, 201);
    const lessonId = lessonResponse.json.data.lesson._id;
    assert.equal(lessonResponse.json.data.lesson.video, null, "Client cannot inject media reference");
    await t.test("course ownership, assigned-only content, and no self-enrollment bypass", async () => {
      assert.equal((await call(`/courses/${courseId}`, { cookie: student.cookie })).status, 403);
      assert.equal((await call(`/courses/${courseId}`, { cookie: otherTeacher.cookie })).status, 403);
      assert.equal((await call(`/courses/${courseId}/enroll`, { method: "POST", cookie: student.cookie })).status, 400, "Enrollment requires a validated price quote");
      assert.equal((await call(`/courses/${courseId}/enroll`, { method: "POST", cookie: student.cookie, body: { quotedAmountMinor: 0 } })).status, 404, "A valid request cannot self-enroll in a private course");
      assert.equal((await call(`/courses/${courseId}/assignments`, { method: "POST", cookie: otherTeacher.cookie, body: { emails: [student.user.email] } })).status, 403);
      assert.equal((await call(`/courses/${courseId}/assignments`, { method: "POST", cookie: teacher.cookie, body: { emails: [student.user.email, "missing@example.test"] } })).status, 400);
      assert.equal(await Enrollment.countDocuments(), 0);
      assert.equal((await call(`/courses/${courseId}/publish`, { method: "PATCH", cookie: teacher.cookie, body: { published: true } })).status, 409);
    });
    const fixture = path.join(directory, "sample.mp4");
    await runMediaCommand("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-t", "8", "-c:v", "libx264", "-crf", "0", "-threads", "2", fixture]);
    const file = await readFile(fixture);
    const start = () => call(`/lessons/${lessonId}/uploads`, { method: "POST", cookie: teacher.cookie, body: { filename: "sample.mp4", size: file.length, fingerprint: digest(file) } });
    const upload = await start();
    assert.equal(upload.status, 200, JSON.stringify(upload.json));
    const assetId = upload.json.data.video._id;
    // Small chunks exercise interrupted multi-part flow with a short actual video fixture.
    const chunkSize = Math.ceil(file.length / 3);
    await VideoAsset.updateOne({ _id: assetId }, { chunkSize, chunkCount: 3 });
    const put = (index, bytes, hash = digest(bytes)) => call(`/uploads/${assetId}/chunks/${index}`, { method: "PUT", cookie: teacher.cookie, body: bytes, headers: { "Content-Type": "application/octet-stream", "X-Chunk-SHA256": hash } });
    await t.test("idempotent upload creation, owner checks, corrupt/missing chunk errors", async () => {
      assert.equal((await start()).json.data.video._id, assetId);
      assert.equal((await call(`/uploads/${assetId}`, { cookie: otherTeacher.cookie })).status, 403);
      assert.equal((await call(`/uploads/${assetId}`, { cookie: student.cookie })).status, 403);
      assert.equal((await put(0, file.subarray(0, chunkSize), "0".repeat(64))).status, 400);
      assert.equal((await put(0, file.subarray(0, chunkSize))).status, 200);
      assert.equal((await put(0, file.subarray(0, chunkSize))).status, 200);
      assert.equal((await put(0, Buffer.alloc(chunkSize))).status, 409);
      assert.deepEqual((await call(`/uploads/${assetId}`, { cookie: teacher.cookie })).json.data.uploadedChunks, [0]);
      assert.equal((await call(`/uploads/${assetId}/complete`, { method: "POST", cookie: teacher.cookie })).status, 409);
      assert.equal((await call(`/uploads/${assetId}/chunks/0/verify`, { method: "POST", cookie: teacher.cookie, body: { digest: digest(file.subarray(0, chunkSize)) } })).status, 200);
      assert.equal((await call(`/uploads/${assetId}/chunks/0/verify`, { method: "POST", cookie: teacher.cookie, body: { digest: "0".repeat(64) } })).status, 409);
    });
    await t.test("resume saved chunks, repeated finalize, and restart recovery during processing", async () => {
      for (let index = 1; index < 3; index++) assert.equal((await put(index, file.subarray(index * chunkSize, (index + 1) * chunkSize))).status, 200);
      assert.equal((await call(`/uploads/${assetId}/complete`, { method: "POST", cookie: teacher.cookie })).status, 202);
      assert.equal((await call(`/uploads/${assetId}/complete`, { method: "POST", cookie: teacher.cookie })).status, 200);
      await VideoAsset.updateOne({ _id: assetId }, { status: "processing", processingToken: "interrupted-worker", leaseUntil: new Date(0) });
      assert.equal(await processNextVideo(), true);
      const status = (await call(`/uploads/${assetId}`, { cookie: teacher.cookie })).json.data.video;
      assert.equal(status.status, "ready", status.error);
      assert.ok(status.duration > 0);
    });
    await t.test("multiple assignments are persisted, idempotent, and invisible before publication", async () => {
      const assign = () => call(`/courses/${courseId}/assignments`, { method: "POST", cookie: teacher.cookie, body: { emails: [student.user.email, otherStudent.user.email] } });
      assert.equal((await assign()).status, 200); assert.equal((await assign()).status, 200);
      assert.equal(await Enrollment.countDocuments({ course: courseId }), 2);
      assert.equal((await call(`/courses/${courseId}`, { cookie: student.cookie })).status, 403);
      assert.equal((await call(`/courses/${courseId}/publish`, { method: "PATCH", cookie: teacher.cookie, body: { published: true } })).status, 200);
      assert.equal((await call(`/courses/${courseId}`, { cookie: student.cookie })).status, 200);
      assert.equal((await call("/enrollments/me", { cookie: student.cookie })).json.data.enrollments.length, 1);
    });
    await t.test("authenticated playback, seeking, invalid ranges, progress and revocation", async () => {
      const media = `/lessons/${lessonId}/video`;
      assert.equal((await call(media)).status, 401);
      const range = await call(media, { cookie: student.cookie, headers: { Range: "bytes=0-99" } });
      assert.equal(range.status, 206); assert.equal(range.bytes.length, 100); assert.match(range.headers.get("content-range"), /^bytes 0-99\//);
      assert.equal(range.headers.get("cache-control"), "private, no-store");
      assert.equal((await call(media, { cookie: student.cookie, headers: { Range: "bytes=999999999-" } })).status, 416);
      assert.equal((await call(media, { method: "HEAD", cookie: student.cookie })).status, 200);
      assert.equal((await call(`/lessons/${lessonId}/complete`, { method: "POST", cookie: student.cookie })).json.data.progress.percentage, 100);
      assert.equal((await call(`/courses/${courseId}/assignments/${otherStudent.user.id}`, { method: "DELETE", cookie: teacher.cookie })).status, 200);
      assert.equal((await call(media, { cookie: otherStudent.cookie })).status, 403);
      assert.equal((await call(`/courses/${courseId}/progress`, { cookie: otherStudent.cookie })).status, 403);
      const preview = await call(`/courses/${courseId}`, { cookie: otherStudent.cookie });
      assert.equal(preview.status, 200);
      assert.equal(preview.json.data.access.videos, false);
      assert.ok(preview.json.data.modules.flatMap((module) => module.lessons).every((lesson) => lesson.locked && !lesson.video));
      const listed = (await call("/courses", { cookie: otherStudent.cookie })).json.data.courses;
      assert.equal(listed.length, 1);
      assert.equal(listed[0].access.assigned, false);
      assert.equal(listed[0].access.videos, false);
      assert.equal((await call(`/lessons/${lessonId}/complete`, { method: "POST", cookie: otherStudent.cookie })).status, 403);
    });
    await t.test("missing storage returns a retryable error without leaking media", async () => {
      const asset = await VideoAsset.findById(assetId);
      const source = outputPath(asset);
      await rename(source, source + ".unavailable");
      try { assert.equal((await call(`/lessons/${lessonId}/video`, { cookie: student.cookie })).status, 503); }
      finally { await rename(source + ".unavailable", source); }
      assert.equal((await call(`/lessons/${lessonId}/video`, { method: "HEAD", cookie: student.cookie })).status, 200);
    });
    await t.test("aborted chunk leaves no partial file and can be retried", async () => {
      const asset = { _id: new mongoose.Types.ObjectId(), size: 10, chunkSize: 10, chunkCount: 1 };
      const bytes = Buffer.from("0123456789");
      const interrupted = Readable.from((async function* () { yield bytes.subarray(0, 5); throw new Error("Simulated connection loss"); })());
      await assert.rejects(storeChunk(asset, 0, digest(bytes), interrupted), /Simulated connection loss/);
      assert.deepEqual(await readdir(assetDir(asset._id)), []);
      await storeChunk(asset, 0, digest(bytes), Readable.from([bytes]));
      assert.equal((await readdir(assetDir(asset._id))).includes("0.chunk"), true);
    });
    await t.test("legacy saved chunks remain readable, new uploads still require integrity metadata", async () => {
      const bytes = Buffer.from("legacy accepted upload chunk");
      const asset = { _id: new mongoose.Types.ObjectId(), size: bytes.length, chunkSize: bytes.length, chunkCount: 1 };
      await storeChunk(asset, 0, digest(bytes), Readable.from([bytes]));
      await rm(`${chunkPath(asset._id, 0)}.sha256`);
      const assembled = path.join(directory, "legacy-assembled");
      await assemble(asset, assembled);
      assert.deepEqual(await readFile(assembled), bytes);
      await rm(`${chunkPath(asset._id, 0)}.sha256`);
      await assert.rejects(assemble({ ...asset, checksumVersion: 1 }, assembled), { code: "ENOENT" });
      await writeFile(`${chunkPath(asset._id, 0)}.sha256`, "0".repeat(64));
      await assert.rejects(assemble(asset, assembled), /corrupt/);
    });
    await t.test("WebM with a misleading 1000 fps declaration converts to bounded 30 fps MP4", async () => {
      const webm = path.join(directory, "high-declared-fps.webm");
      await runMediaCommand("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10", "-t", "3", "-c:v", "libvpx", "-threads", "2", webm]);
      const bytes = await readFile(webm);
      const marker = bytes.indexOf(Buffer.from("23e383", "hex")); // Matroska DefaultDuration
      assert.ok(marker >= 0);
      const width = bytes[marker + 3] & 0x7f;
      assert.equal(width, 4);
      bytes.writeUIntBE(1_000_000, marker + 4, width);
      await writeFile(webm, bytes);
      const input = JSON.parse(await runMediaCommand("ffprobe", ["-v", "error", "-show_streams", "-of", "json", webm]));
      assert.equal(input.streams[0].avg_frame_rate, "1000/1");
      const made = await call(`/courses/${courseId}/modules/${moduleId}/lessons`, { method: "POST", cookie: teacher.cookie, body: { title: "WebM regression", contentType: "video" } });
      const webmLesson = made.json.data.lesson._id;
      const created = await call(`/lessons/${webmLesson}/uploads`, { method: "POST", cookie: teacher.cookie, body: { filename: "high-declared-fps.webm", size: bytes.length, fingerprint: digest(bytes) } });
      const id = created.json.data.video._id;
      assert.equal((await call(`/uploads/${id}/chunks/0`, { method: "PUT", cookie: teacher.cookie, body: bytes, headers: { "Content-Type": "application/octet-stream", "X-Chunk-SHA256": digest(bytes) } })).status, 200);
      assert.equal((await call(`/uploads/${id}/complete`, { method: "POST", cookie: teacher.cookie })).status, 202);
      await processNextVideo();
      const converted = await VideoAsset.findById(id);
      assert.equal(converted.status, "ready", converted.error);
      const output = JSON.parse(await runMediaCommand("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", outputPath(converted)]));
      assert.equal(output.streams[0].codec_name, "h264");
      assert.equal(output.streams[0].avg_frame_rate, "30/1");
      assert.ok(Number(output.streams[0].nb_read_frames) <= 90);
      assert.ok(Number(output.format.duration) <= 3.1);
    });
    await t.test("new curriculum lessons update completion in player, dashboard and assignments", async () => {
      assert.equal((await call(`/courses/${courseId}/progress`, { cookie: student.cookie })).json.data.progress.percentage, 50);
      assert.equal((await call("/enrollments/me", { cookie: student.cookie })).json.data.enrollments[0].status, "active");
      assert.equal((await call(`/courses/${courseId}/assignments`, { cookie: teacher.cookie })).json.data.assignments[0].status, "active");
      const removed = await Lesson.create({ title: "Removed lesson", contentType: "text", course: courseId, module: moduleId, order: 2 });
      await Progress.updateOne({ student: student.user.id, course: courseId }, { $addToSet: { completedLessons: removed._id } });
      await removed.deleteOne();
      const progress = (await call(`/courses/${courseId}/progress`, { cookie: student.cookie })).json.data.progress;
      assert.equal(progress.percentage, 50);
      assert.deepEqual(progress.completedLessons, [lessonId]);
    });
    await t.test("invalid media has a failed state, retry, cancellation and fresh upload", async () => {
      const made = await call(`/courses/${courseId}/modules/${moduleId}/lessons`, { method: "POST", cookie: teacher.cookie, body: { title: "Invalid media test", contentType: "video" } });
      const badLesson = made.json.data.lesson._id;
      const bytes = Buffer.from("This is deliberately not a video.");
      const create = () => call(`/lessons/${badLesson}/uploads`, { method: "POST", cookie: teacher.cookie, body: { filename: "invalid.mp4", size: bytes.length, fingerprint: digest(bytes) } });
      const created = await create();
      const badAsset = created.json.data.video._id;
      assert.equal((await call(`/uploads/${badAsset}/chunks/0`, { method: "PUT", cookie: teacher.cookie, body: bytes, headers: { "Content-Type": "application/octet-stream", "X-Chunk-SHA256": digest(bytes) } })).status, 200);
      assert.equal((await call(`/uploads/${badAsset}/complete`, { method: "POST", cookie: teacher.cookie })).status, 202);
      await processNextVideo();
      assert.equal((await call(`/uploads/${badAsset}`, { cookie: teacher.cookie })).json.data.video.status, "failed");
      assert.equal((await call(`/uploads/${badAsset}/complete`, { method: "POST", cookie: teacher.cookie })).status, 202);
      assert.equal((await call(`/uploads/${badAsset}`, { method: "DELETE", cookie: teacher.cookie })).status, 200);
      assert.equal((await call(`/uploads/${badAsset}/complete`, { method: "POST", cookie: teacher.cookie })).status, 410);
      const fresh = await create();
      assert.equal(fresh.status, 200);
      assert.notEqual(fresh.json.data.video._id, badAsset);
      const freshId = fresh.json.data.video._id;
      await VideoAsset.updateOne({ _id: freshId }, { expiresAt: new Date(0) });
      assert.equal((await call(`/uploads/${freshId}/complete`, { method: "POST", cookie: teacher.cookie })).status, 410);
      assert.equal((await call(`/uploads/${freshId}/chunks/0`, { method: "PUT", cookie: teacher.cookie, body: bytes, headers: { "Content-Type": "application/octet-stream", "X-Chunk-SHA256": digest(bytes) } })).status, 410);
    });
    await t.test("logout revokes captured cookie, repeated logout safe, user switching and expiry", async () => {
      assert.equal((await call("/auth/logout", { method: "POST", cookie: student.cookie })).status, 200);
      assert.equal((await call("/auth/me", { cookie: student.cookie })).status, 401);
      assert.equal((await call(`/lessons/${lessonId}/video`, { cookie: student.cookie })).status, 401);
      assert.equal((await call("/auth/logout", { method: "POST", cookie: student.cookie })).status, 200);
      const next = await call("/auth/login", { method: "POST", cookie: otherStudent.cookie, body: { email: student.user.email, password: fixturePassword } });
      assert.equal(next.status, 200); assert.equal(next.json.data.user.id, student.user.id);
      assert.equal((await call("/auth/me", { cookie: otherStudent.cookie })).status, 401);
      await Session.updateMany({ user: student.user.id }, { expiresAt: new Date(0) });
      assert.equal((await call("/auth/me", { cookie: next.cookie })).status, 401);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    assert.match(mongoose.connection.name, /^lms_test_/);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});
