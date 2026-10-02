import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import sharp from "sharp";
import mongoose from "mongoose";
import app from "../app.js";
import User from "../models/User.js";
import Session from "../models/Session.js";
import Course from "../models/Course.js";
import Category from "../models/Category.js";
import Enrollment from "../models/Enrollment.js";
import AuditEvent from "../models/AuditEvent.js";
import { MAX_THUMBNAIL_BYTES, prepareThumbnail, courseThumbnailStore } from "../services/courseThumbnailStore.js";
const image = (format = "png") => sharp({ create: { width: 640, height: 400, channels: 3, background: "#48bfb5" } }).toFormat(format).toBuffer();

test("thumbnail decoder checks real bytes, bounds pixels and normalizes JPEG/PNG/WebP", async () => {
  for (const format of ["jpeg", "png", "webp"]) {
    const prepared = await prepareThumbnail(await image(format));
    const metadata = await sharp(prepared.bytes).metadata();
    assert.equal(metadata.format, "webp"); assert.ok(metadata.width <= 1200 && metadata.height <= 675);
    assert.equal(metadata.exif, undefined); assert.equal(prepared.sha256.length, 64);
  }
  for (const invalid of [Buffer.from("fake image"), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"></svg>'), (await image()).subarray(0, 80)]) await assert.rejects(prepareThumbnail(invalid), /cannot be decoded/);
  await assert.rejects(prepareThumbnail(Buffer.alloc(MAX_THUMBNAIL_BYTES + 1)), /up to 5 MB/);
  const large = await sharp({ create: { width: 4001, height: 4001, channels: 3, background: "white" } }).png().toBuffer();
  await assert.rejects(prepareThumbnail(large), /cannot be decoded/);
});

test("thumbnail object adapter verifies stored bytes and uses private bounded requests", async () => {
  const commands = [], thumbnail = { storageBucket: "fixture", objectKey: "thumbnails/fixture/image.webp", size: 5 }, prepared = { bytes: Buffer.from("bytes"), sha256: "fixture-hash" };
  const store = courseThumbnailStore({ send: async (command, options) => { commands.push(command); assert.ok(options.abortSignal); return { ContentLength: 5, ContentType: "image/webp", Metadata: { sha256: prepared.sha256 }, Body: Readable.from(prepared.bytes) }; } });
  await store.upload(thumbnail, prepared); assert.equal(commands[0].input.ContentLength, 5); assert.equal(commands[0].input.CacheControl, "private, no-store");
  assert.ok(await store.read(thumbnail));
  const broken = courseThumbnailStore({ send: async () => ({ ContentLength: 1, ContentType: "text/html" }) });
  await assert.rejects(broken.upload(thumbnail, prepared), /confirmation failed/);
  await assert.rejects(broken.read(thumbnail), /unavailable/);
});

test("private course thumbnail lifecycle (isolated MongoDB + HTTP, R2 mocked)", { timeout: 120000 }, async (t) => {
  process.env.NODE_ENV = "test";
  await mongoose.connect(`mongodb://127.0.0.1:${process.env.TEST_MONGO_PORT || 27018}/lms_test_${crypto.randomBytes(6).toString("hex")}`, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([User, Session, Course, Category, Enrollment, AuditEvent].map((model) => model.init()));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`, objects = new Map();
  let failUpload = false, duringUpload;
  app.locals.courseThumbnailStore = { upload: async (thumbnail, prepared) => { if (failUpload) throw new Error("Fixture unavailable"); objects.set(thumbnail.objectKey, prepared.bytes); await duringUpload?.(); }, read: async (thumbnail) => { assert.ok(thumbnail.objectKey); return Readable.from(objects.get(thumbnail.objectKey)); } };
  const request = async (path, cookie, method = "GET", body, binary = false) => {
    const form = body instanceof FormData;
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(!form ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: form ? body : JSON.stringify(body) } : {}) });
    return { status: response.status, headers: response.headers, body: binary ? Buffer.from(await response.arrayBuffer()) : await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const bytes = await image();
  const upload = (course, cookie, file = bytes, type = "image/png", extra = false) => { const form = new FormData(); form.append("thumbnail", new Blob([file], { type }), "cover.png"); if (extra) form.append("extra", "fixture"); return request(`/courses/${course}/thumbnail`, cookie, "POST", form); };
  try {
    const users = {};
    for (const role of ["owner", "other", "admin", "student", "stranger"]) {
      const password = crypto.randomBytes(20).toString("hex");
      const user = await User.create({ name: role, email: `${role}@example.invalid`, password, role: ["owner", "other"].includes(role) ? "instructor" : role === "stranger" ? "student" : role });
      users[role] = { id: user._id, cookie: (await request("/auth/login", null, "POST", { email: user.email, password })).cookie };
    }
    const category = await Category.create({ name: "Design" });
    const course = await Course.create({ title: "Thumbnail fixture", description: "Synthetic fixture", instructor: users.owner.id, category: category._id, thumbnail: { url: "https://fixture.invalid/legacy-cover.png", publicId: "legacy-fixture" } });
    const id = String(course._id), endpoint = `/courses/${id}/thumbnail`;
    let saved;
    await t.test("ownership checked before multipart parsing; actual image validation and size limits enforced", async () => {
      assert.equal((await upload(id)).status, 401);
      for (const role of ["other", "student", "stranger"]) assert.equal((await upload(id, users[role].cookie)).status, 403);
      assert.equal((await upload(id, users.owner.cookie, Buffer.from("fake PNG"))).status, 422);
      assert.equal((await upload(id, users.owner.cookie, bytes, "text/html")).status, 400);
      assert.equal((await upload(id, users.owner.cookie, Buffer.alloc(MAX_THUMBNAIL_BYTES + 1))).status, 413);
      assert.equal((await upload(id, users.owner.cookie, bytes, "image/png", true)).status, 400);
      assert.equal((await Course.findById(id)).thumbnail.url, "https://fixture.invalid/legacy-cover.png");
      const result = await upload(id, users.owner.cookie); assert.equal(result.status, 200); saved = result.body.data.course.thumbnail.url;
      assert.match(saved, /\/api\/courses\/.+\/thumbnail\?v=/);
      for (const field of ["objectKey", "storageBucket", "size"]) assert.equal(result.body.data.course.thumbnail[field], undefined);
      const stored = await Course.findById(id).select("+thumbnail.objectKey +thumbnail.size"); assert.ok(stored.thumbnail.objectKey); assert.ok(stored.thumbnail.size > 0);
      const managed = await request(`/courses/mine/${id}`, users.owner.cookie); assert.equal(managed.body.data.course.thumbnail.url, saved); assert.equal(managed.body.data.course.thumbnail.objectKey, undefined);
    });
    await t.test("only owner/admin or assigned students can read image; bytes and private headers survive", async () => {
      assert.equal((await request(endpoint)).status, 401);
      for (const role of ["student", "stranger", "other"]) assert.equal((await request(endpoint, users[role].cookie)).status, 403);
      await Course.updateOne({ _id: id }, { isPublished: true });
      await Enrollment.create({ course: id, student: users.student.id, assignedBy: users.owner.id });
      for (const role of ["owner", "admin", "student"]) {
        const read = await request(endpoint, users[role].cookie, "GET", undefined, true);
        assert.equal(read.status, 200); assert.equal(read.headers.get("content-type"), "image/webp"); assert.equal(read.headers.get("cache-control"), "private, no-store"); assert.equal((await sharp(read.body).metadata()).format, "webp");
      }
      assert.equal((await request(endpoint, users.stranger.cookie)).status, 403);
      assert.equal((await request("/enrollments/me", users.student.cookie)).body.data.enrollments[0].course.thumbnail.url, saved);
    });
    await t.test("replacement persists, old objects retained and storage failure preserves current image", async () => {
      failUpload = true; assert.equal((await upload(id, users.owner.cookie)).status, 503); assert.equal((await Course.findById(id)).thumbnail.url, saved);
      failUpload = false; const replaced = await upload(id, users.admin.cookie, await image("jpeg"), "image/jpeg"); assert.equal(replaced.status, 200); assert.notEqual(replaced.body.data.course.thumbnail.url, saved); assert.equal(objects.size, 2);
      saved = replaced.body.data.course.thumbnail.url;
      for (let attempt = 0; attempt < 50 && await AuditEvent.exists({ outcome: "pending" }); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(await AuditEvent.countDocuments({ outcome: "pending" }), 0);
      const database = mongoose.connection.name;
      await mongoose.disconnect(); await mongoose.connect(`mongodb://127.0.0.1:${process.env.TEST_MONGO_PORT || 27018}/${database}`);
      assert.equal((await Course.findById(id)).thumbnail.url, saved);
    });
    await t.test("archive, assignment revocation and concurrent transfer cannot reopen image access", async () => {
      await Enrollment.deleteMany({ course: id }); assert.equal((await request(endpoint, users.student.cookie)).status, 403);
      await Course.updateOne({ _id: id }, { archivedAt: new Date(), isPublished: false });
      assert.equal((await upload(id, users.owner.cookie)).status, 410); assert.equal((await request(endpoint, users.student.cookie)).status, 410);
      assert.equal((await request(endpoint, users.owner.cookie, "GET", undefined, true)).status, 200); assert.equal(objects.size, 2);
      await Course.updateOne({ _id: id }, { archivedAt: null });
      duringUpload = () => Course.updateOne({ _id: id }, { instructor: users.other.id });
      assert.equal((await upload(id, users.owner.cookie)).status, 409); assert.equal((await Course.findById(id)).thumbnail.url, saved);
      assert.equal((await request(endpoint, users.owner.cookie)).status, 403);
    });
    await t.test("two in-flight image jobs retain their slots when a client disconnects", async () => {
      let entered = 0, signalReady, release;
      const ready = new Promise((resolve) => { signalReady = resolve; }), gate = new Promise((resolve) => { release = resolve; });
      duringUpload = async () => { if (++entered === 2) signalReady(); await gate; };
      const firstController = new AbortController();
      const pendingUpload = (signal) => { const form = new FormData(); form.append("thumbnail", new Blob([bytes], { type: "image/png" }), "fixture.png"); return fetch(base + endpoint, { method: "POST", headers: { cookie: users.other.cookie }, body: form, signal }); };
      const first = pendingUpload(firstController.signal).catch((error) => { assert.equal(error.name, "AbortError"); });
      const second = pendingUpload();
      try {
        await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("Jobs did not reach storage")), 5000))]);
        firstController.abort(); await first;
        assert.equal((await upload(id, users.other.cookie)).status, 503);
      } finally { release(); }
      assert.equal((await second).status, 200);
      for (let attempt = 0; attempt < 50 && !await Course.exists({ _id: id, "thumbnail.url": { $ne: saved } }); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    });
  } finally { await new Promise((resolve) => server.close(resolve)); assert.match(mongoose.connection.name, /^lms_test_/); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); delete app.locals.courseThumbnailStore; }
});
