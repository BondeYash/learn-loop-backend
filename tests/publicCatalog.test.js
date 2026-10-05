import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import mongoose from "mongoose";
import app from "../app.js";
import User from "../models/User.js";
import Session from "../models/Session.js";
import Course from "../models/Course.js";
import Category from "../models/Category.js";
import Module from "../models/Module.js";
import Lesson from "../models/Lesson.js";
import VideoAsset from "../models/VideoAsset.js";

test("anonymous discovery and selected samples stay separate from private learning (isolated MongoDB + HTTP, storage mocked)", { timeout: 60000 }, async (t) => {
  process.env.NODE_ENV = "test";
  await mongoose.connect(`mongodb://127.0.0.1:${process.env.TEST_MONGO_PORT || 27018}/lms_test_${crypto.randomBytes(6).toString("hex")}`, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([User, Session, Course, Category, Module, Lesson, VideoAsset].map((model) => model.init()));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, cookie, method = "GET", body, binary = false) => {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, headers: response.headers, body: binary ? Buffer.from(await response.arrayBuffer()) : await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  let duringPlayback, duringThumbnail, playbackCalls = 0;
  app.locals.directVideoStore = { playback: async (asset) => { playbackCalls++; assert.equal(asset.objectKey, "private/selected.mp4"); await duringPlayback?.(); return { url: "https://fixture.invalid/sample.mp4?signature=fixture", expiresAt: Date.now() + 300000, objectKey: "NEVER_EXPOSE_STORE_METADATA" }; } };
  app.locals.courseThumbnailStore = { read: async (thumbnail) => { assert.equal(thumbnail.objectKey, "private/cover.webp"); await duringThumbnail?.(); return Readable.from(Buffer.from("webp-fixture")); } };
  try {
    const users = {};
    for (const [name, role] of [["owner", "instructor"], ["other", "instructor"], ["student", "student"], ["admin", "admin"]]) {
      const password = crypto.randomBytes(24).toString("hex"); const user = await User.create({ name: "PRIVATE_ACCOUNT_NAME", bio: "PRIVATE_ACCOUNT_BIO", role, email: `${name}@example.invalid`, password });
      users[name] = { id: user._id, cookie: (await call("/auth/login", null, "POST", { email: user.email, password })).cookie };
    }
    const category = await Category.create({ name: "Computer qualification" }), hiddenCategory = await Category.create({ name: "Hidden inventory" });
    const makeCourse = (title, extra = {}) => Course.create({ title, description: "Owner-written course description", instructor: users.owner.id, category: hiddenCategory._id, ...extra });
    const hidden = [await makeCourse("Private published", { isPublished: true }), await makeCourse("Legacy published", { isPublished: true }), await makeCourse("Public draft", { visibility: "public" }), await makeCourse("Public archived", { visibility: "public", isPublished: true, archivedAt: new Date() })];
    await Course.collection.updateOne({ _id: hidden[1]._id }, { $unset: { visibility: "" } });
    const course = await makeCourse("Synthetic CCC course", { category: category._id, examName: "CCC", visibility: "public", isPublished: true, publishedAt: new Date(), price: 120.5, summary: "Synthetic test course", language: "Hindi", audience: "Synthetic aspirants", publicInstructorName: "Public teaching name", publicInstructorBio: "Explicit public bio", supportEmail: "support@example.invalid", supportUrl: "https://fixture.invalid/support", termsUrl: "https://fixture.invalid/terms", thumbnail: { url: "/api/courses/cover/thumbnail?v=fixture", objectKey: "private/cover.webp", storageBucket: "PRIVATE_BUCKET", size: 12 } });
    const module = await Module.create({ course: course._id, title: "Basics", order: 0 });
    const text = await Lesson.create({ course: course._id, module: module._id, title: "Text sample", contentType: "text", content: "Public sample\nA useful second line.", order: 0 });
    const locked = await Lesson.create({ course: course._id, module: module._id, title: "Protected lesson", contentType: "text", content: "PRIVATE_LESSON_CONTENT", contentUrl: "https://fixture.invalid/PRIVATE_CONTENT_URL", isPreview: true, order: 1 });
    const videoLesson = await Lesson.create({ course: course._id, module: module._id, title: "Video sample", order: 2 });
    const video = await VideoAsset.create({ owner: users.owner.id, course: course._id, lesson: videoLesson._id, fingerprint: "synthetic", size: 100, chunkSize: 0, chunkCount: 0, status: "ready", storageProvider: "r2", uploadMode: "direct", objectKey: "private/selected.mp4", storageBucket: "PRIVATE_BUCKET", expiresAt: new Date(Date.now() + 3600000) });
    await Lesson.updateOne({ _id: videoLesson._id }, { video: video._id });
    const endpoint = `/public/courses/${course._id}`;
    await t.test("all published unarchived metadata is discoverable; private and legacy enrollment stays restricted", async () => {
      const list = await call("/public/courses"); assert.equal(list.status, 200); assert.equal(list.headers.get("cache-control"), "private, no-store");
      assert.equal(list.body.data.total, 3); assert.equal(list.body.data.courses.find((item) => item.id === String(course._id)).amountMinor, 12050); assert.equal(list.body.data.categories.length, 2);
      for (const item of hidden.slice(0, 2)) {
        const card = list.body.data.courses.find((entry) => entry.id === String(item._id));
        assert.deepEqual(card.availability, { enrollment: "assignment", ready: false }); assert.equal(card.hasPreview, false);
        for (const id of [item._id, item.slug]) assert.equal((await call(`/public/courses/${id}`)).status, 200);
        assert.equal((await call(`/public/courses/${item._id}/preview`)).status, 404);
        assert.equal((await call(`/courses/${item._id}/enroll`, users.student.cookie, "POST", { quotedAmountMinor: 0 })).status, 404);
        assert.equal((await call(`/payments/courses/${item._id}/quote`, users.student.cookie)).status, 403);
        for (const suffix of ["/notes", "/progress", "/assessments"]) assert.equal((await call(`/courses/${item._id}${suffix}`, users.student.cookie)).status, 403);
      }
      assert.equal((await call(`/public/courses/${course.slug}`)).status, 200);
      for (const item of hidden.slice(2)) for (const id of [item._id, item.slug]) for (const suffix of ["", "/preview", "/thumbnail"]) assert.equal((await call(`/public/courses/${id}${suffix}`)).status, 404);
      assert.equal((await call("/public/courses?q=ccc")).body.data.total, 1);
      assert.equal((await call("/public/courses?q=.*")).body.data.total, 0);
      assert.equal((await call(`/public/courses?category=${hiddenCategory._id}`)).body.data.total, 2);
      assert.equal((await call("/public/courses?page=2&limit=1")).body.data.courses.length, 1);
      for (const query of ["page=-1", "page=1.5", "limit=51", "category=invalid", "q=" + "x".repeat(101)]) assert.equal((await call("/public/courses?" + query)).status, 400);
    });
    await t.test("public DTOs exclude account profiles, keys, full lesson bodies and legacy preview flags", async () => {
      const detail = await call(endpoint); assert.equal(detail.status, 200); assert.equal(detail.body.data.course.instructorName, "Public teaching name");
      assert.equal(detail.body.data.course.thumbnail.url, `/api/public/courses/${course._id}/thumbnail`);
      assert.deepEqual(Object.keys(detail.body.data.modules[0].lessons[1]).sort(), ["contentType", "duration", "preview", "title"]); assert.equal(detail.body.data.modules[0].lessons[1].preview, false);
      for (const result of [detail, await call("/public/courses")]) {
        const json = JSON.stringify(result.body);
        for (const secret of ["PRIVATE_ACCOUNT_NAME", "PRIVATE_ACCOUNT_BIO", "owner@example.invalid", String(users.owner.id), "PRIVATE_BUCKET", "private/cover.webp", "private/selected.mp4", "PRIVATE_LESSON_CONTENT", "PRIVATE_CONTENT_URL", "password"]) assert.ok(!json.includes(secret), secret);
      }
      assert.equal((await call(endpoint + "/preview")).status, 404);
      assert.equal((await call(`/courses/${course._id}`)).status, 401);
      const student = await call(`/courses/${course._id}`, users.student.cookie); assert.equal(student.status, 200); assert.equal(student.body.data.access.videos, false); assert.equal(student.body.data.modules[0].lessons[0].content, undefined);
      assert.equal((await call(`/lessons/${videoLesson._id}/playback`, users.student.cookie)).status, 403);
      assert.equal((await call(`/courses/${course._id}/notes`, users.student.cookie)).status, 403);
    });
    await t.test("owner selects only a usable same-course sample; student and another instructor cannot expose it", async () => {
      for (const name of ["other", "student"]) assert.equal((await call(`/courses/${course._id}`, users[name].cookie, "PATCH", { previewLesson: text._id, visibility: "public" })).status, 403);
      const foreignModule = await Module.create({ course: hidden[0]._id, title: "Foreign", order: 0 });
      const foreign = await Lesson.create({ course: hidden[0]._id, module: foreignModule._id, title: "Foreign sample", contentType: "text", content: "Foreign text", order: 0 });
      assert.equal((await call(`/courses/${course._id}`, users.owner.cookie, "PATCH", { previewLesson: foreign._id })).status, 400);
      await VideoAsset.updateOne({ _id: video._id }, { status: "uploading" });
      assert.equal((await call(endpoint)).body.data.course.availability.ready, false);
      assert.equal((await call(`/courses/${course._id}`, users.owner.cookie, "PATCH", { previewLesson: videoLesson._id })).status, 400);
      await VideoAsset.updateOne({ _id: video._id }, { status: "ready", lesson: locked._id });
      assert.equal((await call(endpoint)).body.data.course.availability.ready, true);
      assert.equal((await call(`/courses/${course._id}`, users.owner.cookie, "PATCH", { previewLesson: videoLesson._id })).status, 400);
      await VideoAsset.updateOne({ _id: video._id }, { lesson: videoLesson._id });
      assert.equal((await call(`/courses/${course._id}/lessons/${text._id}`, users.owner.cookie, "PATCH", { content: "x".repeat(50001) })).status, 400);
      assert.equal((await call(`/courses/${course._id}`, users.owner.cookie, "PATCH", { previewLesson: text._id })).status, 200);
      const sample = await call(endpoint + "/preview"); assert.equal(sample.status, 200); assert.equal(sample.body.data.preview.content, text.content); assert.ok(!JSON.stringify(sample.body).includes("PRIVATE_LESSON_CONTENT")); assert.equal(playbackCalls, 0);
      assert.equal((await call(`/courses/${course._id}/lessons/${text._id}`, users.owner.cookie, "PATCH", { content: "Updated public sample" })).status, 200); assert.equal((await call(endpoint + "/preview")).body.data.preview.content, "Updated public sample");
      assert.equal((await call(`/courses/${course._id}`, users.admin.cookie, "PATCH", { previewLesson: videoLesson._id })).status, 200);
      const playback = await call(endpoint + "/preview"); assert.equal(playback.status, 200); assert.match(playback.body.data.preview.url, /^https:/); assert.ok(playback.body.data.preview.expiresAt > Date.now()); assert.equal(playback.body.data.preview.objectKey, undefined);
      assert.equal((await call(endpoint + "/thumbnail", null, "GET", null, true)).body.toString(), "webp-fixture");
    });
    await t.test("unsafe owner links fail validation; public DTO clamps unsafe legacy links", async () => {
      for (const url of ["javascript:alert(1)", "http://fixture.invalid", "https://user:password@fixture.invalid"]) assert.equal((await call(`/courses/${course._id}`, users.owner.cookie, "PATCH", { supportUrl: url })).status, 400);
      await Course.updateOne({ _id: course._id }, { refundPolicyUrl: "javascript:alert(1)" });
      assert.equal((await call(endpoint)).body.data.course.policies.refund, "");
      assert.equal((await call(`/courses/${course._id}`, users.owner.cookie, "PATCH", { supportEmail: "invalid" })).status, 400);
    });
    await t.test("private enrollment hides samples; unpublication and archive hide metadata and media", async () => {
      await Course.updateOne({ _id: course._id }, { visibility: "private" });
      const privateDetail = await call(endpoint); assert.equal(privateDetail.status, 200);
      assert.deepEqual(privateDetail.body.data.course.availability, { enrollment: "assignment", ready: true });
      assert.equal(privateDetail.body.data.course.hasPreview, false);
      assert.ok(privateDetail.body.data.modules.flatMap((module) => module.lessons).every((lesson) => !lesson.preview && !lesson.content && !lesson.video));
      assert.equal((await call(endpoint + "/preview")).status, 404);
      assert.equal((await call(endpoint + "/thumbnail", null, "GET", null, true)).status, 200);
      assert.equal((await call(`/courses/${course._id}/enroll`, users.student.cookie, "POST", { quotedAmountMinor: 12050 })).status, 404);
      await Course.updateOne({ _id: course._id }, { visibility: "public" });
      for (const changes of [{ isPublished: false }, { archivedAt: new Date() }]) {
        await Course.updateOne({ _id: course._id }, changes);
        for (const suffix of ["", "/preview", "/thumbnail"]) assert.equal((await call(endpoint + suffix)).status, 404);
        await Course.updateOne({ _id: course._id }, { visibility: "public", isPublished: true, archivedAt: null });
      }
      duringPlayback = () => Course.updateOne({ _id: course._id }, { visibility: "private" });
      assert.equal((await call(endpoint + "/preview")).status, 404); duringPlayback = null;
      await Course.updateOne({ _id: course._id }, { visibility: "public" });
      duringThumbnail = () => Course.updateOne({ _id: course._id }, { isPublished: false });
      assert.equal((await call(endpoint + "/thumbnail")).status, 404); duringThumbnail = null;
      await Course.updateOne({ _id: course._id }, { isPublished: true });
      await call(`/courses/${course._id}`, users.owner.cookie, "PATCH", { previewLesson: null }); assert.equal((await call(endpoint + "/preview")).status, 404);
      await call(`/courses/${course._id}`, users.owner.cookie, "PATCH", { previewLesson: text._id });
      assert.equal((await call(`/courses/${course._id}/lessons/${text._id}`, users.owner.cookie, "DELETE")).status, 200); assert.equal((await Course.findById(course._id)).previewLesson, null);
    });
  } finally { await new Promise((resolve) => server.close(resolve)); assert.match(mongoose.connection.name, /^lms_test_/); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); delete app.locals.directVideoStore; delete app.locals.courseThumbnailStore; }
});
