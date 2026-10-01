import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import mongoose from "mongoose";
import app from "../app.js";
import User from "../models/User.js";
import Session from "../models/Session.js";
import Category from "../models/Category.js";
import Course from "../models/Course.js";
import Module from "../models/Module.js";
import Lesson from "../models/Lesson.js";
import Enrollment from "../models/Enrollment.js";
import VideoAsset from "../models/VideoAsset.js";
import { directVideoStore, mp4Header } from "../services/directVideoStore.js";
const header = Buffer.alloc(24); header.writeUInt32BE(24); header.write("ftypisom", 4); header.write("mp42", 16);
test("MP4 container inspection does not accept extension or Content-Type alone", () => {
  assert.equal(mp4Header(header), true);
  assert.equal(mp4Header(Buffer.from("not a video, despite its file extension")), false);
  const mov = Buffer.from(header); mov.write("qt  ", 8); assert.equal(mp4Header(mov), false);
});
test("R2 verification checks metadata and freezes the upload through conditional server-side copy (SDK mock)", async () => {
  const asset = { _id: "upload-1", size: 2048, storageBucket: "private-fixture", uploadKey: "incoming/upload-1/file.mp4", uploadMode: "direct" };
  const commands = [];
  const head = { ContentLength: 2048, ContentType: "video/mp4", Metadata: { "upload-id": "upload-1" }, ETag: '"version-one"' };
  const client = { send: async (command) => { commands.push(command); if (command.constructor.name === "GetObjectCommand") return { Body: { transformToByteArray: async () => header } }; return head; } };
  const store = directVideoStore(client, async (_client, command, options) => { assert.equal(command.input.ContentType, "video/mp4"); assert.equal(options.signableHeaders.has("content-type"), true); return "https://storage.example.invalid/signed"; });
  assert.equal((await store.uploadTicket(asset)).headers["x-amz-meta-upload-id"], asset._id);
  assert.equal((await store.finalize(asset, "videos/upload-1/immutable.mp4")).outputSize, 2048);
  const copy = commands.find((c) => c.constructor.name === "CopyObjectCommand");
  assert.equal(copy.input.CopySourceIfMatch, head.ETag);
  assert.equal(copy.input.Key, "videos/upload-1/immutable.mp4");
  assert.equal(commands.find((c) => c.constructor.name === "GetObjectCommand").input.IfMatch, head.ETag);
  for (const bad of [{ ContentLength: 2049 }, { ContentType: "video/webm" }, { Metadata: { "upload-id": "someone-else" } }]) {
    const broken = directVideoStore({ send: async () => ({ ...head, ...bad }) });
    await assert.rejects(broken.finalize(asset, "destination"), /does not match/);
  }
});
test("direct upload and signed playback authorization (real MongoDB/HTTP; object storage mocked)", { timeout: 60000 }, async (t) => {
  process.env.NODE_ENV = "test";
  const db = `lms_test_${crypto.randomBytes(6).toString("hex")}`;
  await mongoose.connect(`mongodb://127.0.0.1:${process.env.TEST_MONGO_PORT || 27018}/${db}`, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([User, Session, Category, Course, Module, Lesson, Enrollment, VideoAsset].map((model) => model.init()));
  const accepted = new Set(); let finalizations = 0; let playbackIssues = 0;
  app.locals.directVideoStore = {
    uploadTicket: async (a) => ({ url: `https://storage.example.invalid/${a._id}`, headers: { "Content-Type": "video/mp4" }, expiresAt: Date.now() + 900000 }),
    finalize: async (a) => { finalizations++; if (!accepted.has(String(a._id))) throw new Error("Simulated missing object"); return { outputSize: a.size }; },
    cleanupIncoming: async () => {},
    playback: async () => { playbackIssues++; return { url: "https://storage.example.invalid/playback", expiresAt: Date.now() + 300000 }; },
  };
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (route, cookie, method = "GET", body) => { const r = await fetch(base + route, { method, headers: { ...(cookie ? { cookie } : {}), "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json(), cookie: r.headers.get("set-cookie")?.split(";")[0] }; };
  const register = async (role, name) => { const password = crypto.randomBytes(24).toString("hex"); if (role === "instructor") { await User.create({ name, role, email: `${name}@example.invalid`, password }); const r = await call("/auth/login", null, "POST", { email: `${name}@example.invalid`, password }); assert.equal(r.status, 200); return r; } const r = await call("/auth/register", null, "POST", { name, role, email: `${name}@example.invalid`, password }); assert.equal(r.status, 201); return r; };
  try {
    const teacher = await register("instructor", "direct-teacher");
    const other = await register("instructor", "other-teacher");
    const learner = await register("student", "assigned-student");
    const stranger = await register("student", "unassigned-student");
    const category = await Category.create({ name: "General" });
    const course = (await call("/courses", teacher.cookie, "POST", { title: "Direct video", description: "Fixture", category: String(category._id) })).body.data.course._id;
    const module = (await call(`/courses/${course}/modules`, teacher.cookie, "POST", { title: "Video" })).body.data.module._id;
    const lesson = (await call(`/courses/${course}/modules/${module}/lessons`, teacher.cookie, "POST", { title: "MP4", contentType: "video" })).body.data.lesson._id;
    const uploadBody = { filename: "fixture.mp4", size: 2048, fingerprint: "a".repeat(64), duration: 8, width: 640, height: 360, objectKey: "attacker-chosen-key", owner: stranger.body.data.user.id };
    let id;
    await t.test("requires course ownership, validates media claims and creates only server-chosen keys", async () => {
      assert.equal((await call(`/lessons/${lesson}/direct-uploads`, other.cookie, "POST", uploadBody)).status, 403);
      assert.equal((await call(`/lessons/${lesson}/direct-uploads`, teacher.cookie, "POST", { ...uploadBody, filename: "fixture.webm" })).status, 400);
      assert.equal((await call(`/lessons/${lesson}/direct-uploads`, teacher.cookie, "POST", { ...uploadBody, duration: 0 })).status, 400);
      const made = await call(`/lessons/${lesson}/direct-uploads`, teacher.cookie, "POST", uploadBody); assert.equal(made.status, 200); id = made.body.data.video._id;
      assert.equal((await call(`/lessons/${lesson}/direct-uploads`, teacher.cookie, "POST", uploadBody)).body.data.video._id, id);
      assert.equal(made.body.data.video.uploadKey, undefined);
      const asset = await VideoAsset.findById(id); assert.equal(String(asset.owner), teacher.body.data.user.id); assert.match(asset.uploadKey, new RegExp(`^incoming/${id}/`));
    });
    await t.test("only the owner receives upload links; incomplete uploads cannot publish", async () => {
      assert.equal((await call(`/uploads/${id}/complete`, teacher.cookie, "POST", {})).status, 409);
      assert.equal((await call(`/direct-uploads/${id}/url`, other.cookie, "POST", {})).status, 403);
      assert.equal((await call(`/direct-uploads/${id}/url`, teacher.cookie, "POST", {})).status, 200);
      assert.equal((await call(`/direct-uploads/${id}/complete`, teacher.cookie, "POST", {})).status, 503);
      assert.equal((await call(`/courses/${course}/publish`, teacher.cookie, "PATCH", { published: true })).status, 409);
    });
    await t.test("successful completion is idempotent and cannot issue another PUT URL", async () => {
      accepted.add(id);
      const ready = await call(`/direct-uploads/${id}/complete`, teacher.cookie, "POST", {}); assert.equal(ready.status, 200); assert.equal(ready.body.data.video.status, "ready");
      const count = finalizations; assert.equal((await call(`/direct-uploads/${id}/complete`, teacher.cookie, "POST", {})).status, 200); assert.equal(finalizations, count);
      assert.equal((await call(`/direct-uploads/${id}/url`, teacher.cookie, "POST", {})).status, 409);
      assert.match((await VideoAsset.findById(id)).objectKey, new RegExp(`^videos/${id}/`));
    });
    await t.test("playback links require login, assignment and publication", async () => {
      const route = `/lessons/${lesson}/playback`;
      assert.equal((await call(route)).status, 401);
      assert.equal((await call(route, learner.cookie)).status, 403);
      assert.equal((await call(`/courses/${course}/assignments`, teacher.cookie, "POST", { emails: [learner.body.data.user.email] })).status, 200);
      assert.equal((await call(route, learner.cookie)).status, 403);
      assert.equal((await call(`/courses/${course}/publish`, teacher.cookie, "PATCH", { published: true })).status, 200);
      const granted = await call(route, learner.cookie); assert.equal(granted.status, 200); assert.ok(granted.body.data.expiresAt > Date.now());
      assert.equal((await call(route, stranger.cookie)).status, 403);
      const count = playbackIssues;
      await call(`/courses/${course}/assignments/${learner.body.data.user.id}`, teacher.cookie, "DELETE");
      assert.equal((await call(route, learner.cookie)).status, 403); assert.equal(playbackIssues, count);
    });
    await t.test("removed and expired uploads cannot obtain new upload links", async () => {
      assert.equal((await call(`/uploads/${id}`, teacher.cookie, "DELETE")).status, 200);
      assert.equal((await call(`/direct-uploads/${id}/url`, teacher.cookie, "POST", {})).status, 410);
      const newUpload = await call(`/lessons/${lesson}/direct-uploads`, teacher.cookie, "POST", uploadBody); assert.equal(newUpload.status, 200);
      const nextId = newUpload.body.data.video._id; assert.notEqual(nextId, id);
      await VideoAsset.updateOne({ _id: nextId }, { expiresAt: new Date(0) });
      assert.equal((await call(`/direct-uploads/${nextId}/url`, teacher.cookie, "POST", {})).status, 410);
      assert.equal((await call(`/direct-uploads/${nextId}/complete`, teacher.cookie, "POST", {})).status, 410);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    assert.match(mongoose.connection.name, /^lms_test_/); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); delete app.locals.directVideoStore;
  }
});
