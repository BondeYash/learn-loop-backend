import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import mongoose from "mongoose";
import app from "../app.js";
import User from "../models/User.js";
import Session from "../models/Session.js";
import Course from "../models/Course.js";
import Category from "../models/Category.js";
import Module from "../models/Module.js";
import Lesson from "../models/Lesson.js";
import VideoAsset from "../models/VideoAsset.js";
import Enrollment from "../models/Enrollment.js";
import Progress from "../models/Progress.js";
import AuditEvent from "../models/AuditEvent.js";

test("course CRUD and recoverable archive (isolated MongoDB + HTTP)", { timeout: 60000 }, async (t) => {
  process.env.NODE_ENV = "test";
  await mongoose.connect(`mongodb://127.0.0.1:${process.env.TEST_MONGO_PORT || 27018}/lms_test_${crypto.randomBytes(6).toString("hex")}`, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([User, Session, Course, Category, Module, Lesson, VideoAsset, Enrollment, Progress, AuditEvent].map((m) => m.init()));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, cookie, method = "GET", body) => {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  try {
    const users = {};
    for (const [name, role] of [["teacher", "instructor"], ["other", "instructor"], ["student", "student"], ["admin", "admin"]]) {
      const password = crypto.randomBytes(24).toString("hex"); const user = await User.create({ name, role, email: `${name}@example.invalid`, password });
      users[name] = { id: user._id, cookie: (await call("/auth/login", null, "POST", { email: user.email, password })).cookie };
    }
    const category = await Category.create({ name: "General" }); let course, lesson, video, module;
    await t.test("owner creates/reads/edits; forged owner, publication and archive fields are ignored", async () => {
      const made = await call("/courses", users.teacher.cookie, "POST", { title: "Original", description: "Course fixture", category: category._id, instructor: users.other.id, isPublished: true, archivedAt: new Date() });
      assert.equal(made.status, 201); course = made.body.data.course;
      assert.equal(course.instructor, String(users.teacher.id)); assert.equal(course.isPublished, false); assert.equal(course.archivedAt, null);
      const updated = await call(`/courses/${course._id}`, users.teacher.cookie, "PATCH", { title: "Updated title", description: "Edited description", language: "Hindi", level: "intermediate", requirements: ["A browser"], learningOutcomes: ["Learn safely"], instructor: users.other.id, isPublished: true });
      assert.equal(updated.status, 200); assert.equal(updated.body.data.course.title, "Updated title"); assert.equal(updated.body.data.course.isPublished, false); assert.equal(updated.body.data.course.instructor, String(users.teacher.id));
      assert.equal((await call(`/courses/${course._id}`, users.other.cookie, "PATCH", { title: "Stolen" })).status, 403);
      assert.equal((await call(`/courses/${course._id}`, users.student.cookie, "PATCH", { title: "Student edit" })).status, 403);
      assert.equal((await call(`/courses/${course._id}`, users.teacher.cookie, "PATCH", { category: "bad-id" })).status, 400);
      assert.equal((await call(`/courses/${course._id}`, users.admin.cookie, "PATCH", { description: "Admin reviewed" })).status, 200);
      module = await Module.create({ course: course._id, title: "Module", order: 0 });
      lesson = await Lesson.create({ course: course._id, module: module._id, title: "Video", order: 0 });
      video = await VideoAsset.create({ owner: users.teacher.id, course: course._id, lesson: lesson._id, fingerprint: "fixture", filename: "fixture.mp4", size: 200, chunkSize: 0, chunkCount: 0, status: "ready", uploadMode: "direct", storageProvider: "r2", objectKey: "videos/retained-object", expiresAt: new Date(Date.now() + 3600000) });
      await Lesson.updateOne({ _id: lesson._id }, { video: video._id });
      await Enrollment.create({ course: course._id, student: users.student.id, assignedBy: users.teacher.id });
      await Progress.create({ course: course._id, student: users.student.id, completedLessons: [lesson._id], percentage: 100 });
      assert.equal((await call(`/courses/${course._id}/publish`, users.teacher.cookie, "PATCH", { published: true })).status, 200);
      assert.equal((await call(`/courses/${course._id}`, users.student.cookie)).status, 200);
    });
    await t.test("archive is repeatable, owner/admin-only, denies fresh playback and preserves all related records", async () => {
      assert.equal((await call(`/courses/${course._id}`, users.other.cookie, "DELETE")).status, 403);
      assert.equal((await call(`/courses/${course._id}`, users.student.cookie, "DELETE")).status, 403);
      for (let i = 0; i < 2; i++) assert.equal((await call(`/courses/${course._id}`, users.teacher.cookie, "DELETE")).status, 200);
      const saved = await Course.findById(course._id); assert.ok(saved.archivedAt); assert.equal(saved.isPublished, false);
      assert.equal((await call(`/courses/${course._id}`, users.student.cookie)).status, 410);
      assert.equal((await call(`/lessons/${lesson._id}/playback`, users.student.cookie)).status, 410);
      assert.equal((await call(`/lessons/${lesson._id}/playback`, users.admin.cookie)).status, 410);
      assert.equal((await call(`/lessons/${lesson._id}/complete`, users.student.cookie, "POST", {})).status, 410);
      assert.equal((await call(`/courses/${course._id}/publish`, users.teacher.cookie, "PATCH", { published: true })).status, 410);
      assert.equal((await call(`/courses/${course._id}`, users.teacher.cookie, "PATCH", { title: "Archived edit" })).status, 410);
      assert.equal((await call("/courses", users.student.cookie)).body.data.courses.length, 0);
      assert.equal((await call("/courses/mine", users.teacher.cookie)).body.data.courses.length, 0);
      assert.equal((await call("/courses/mine?archived=true", users.teacher.cookie)).body.data.courses.length, 1);
      assert.equal((await call("/admin/courses?archived=true", users.admin.cookie)).body.data.total, 1);
      assert.equal(await Module.countDocuments({ course: course._id }), 1); assert.equal(await Lesson.countDocuments({ course: course._id }), 1);
      assert.equal(await Enrollment.countDocuments({ course: course._id }), 1); assert.equal(await Progress.countDocuments({ course: course._id }), 1);
      const retained = await VideoAsset.findById(video._id); assert.equal(retained.status, "ready"); assert.equal(retained.objectKey, "videos/retained-object");
    });
    await t.test("restore keeps course private until publication and restores completion/assignments", async () => {
      assert.equal((await call(`/courses/${course._id}/restore`, users.other.cookie, "POST", {})).status, 403);
      assert.equal((await call(`/courses/${course._id}/restore`, users.student.cookie, "POST", {})).status, 403);
      for (let i = 0; i < 2; i++) assert.equal((await call(`/courses/${course._id}/restore`, users.admin.cookie, "POST", {})).status, 200);
      assert.equal((await Course.findById(course._id)).isPublished, false);
      assert.equal((await call(`/courses/${course._id}`, users.student.cookie)).status, 403);
      await call(`/courses/${course._id}/publish`, users.teacher.cookie, "PATCH", { published: true });
      assert.equal((await call(`/courses/${course._id}`, users.student.cookie)).status, 200);
      assert.equal((await call(`/courses/${course._id}/progress`, users.student.cookie)).body.data.progress.percentage, 100);
      // A retry of restore against an active published course must not unpublish it.
      await call(`/courses/${course._id}/restore`, users.admin.cookie, "POST", {});
      assert.equal((await Course.findById(course._id)).isPublished, true);
    });
    await t.test("archive wins over a concurrent publication and never purges objects", async () => {
      const results = await Promise.all([call(`/courses/${course._id}/publish`, users.teacher.cookie, "PATCH", { published: true }), call(`/courses/${course._id}`, users.admin.cookie, "DELETE")]);
      assert.equal(results[1].status, 200); assert.ok([200, 409, 410].includes(results[0].status));
      const saved = await Course.findById(course._id); assert.ok(saved.archivedAt); assert.equal(saved.isPublished, false);
      assert.equal(await VideoAsset.countDocuments({ _id: video._id }), 1);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve)); assert.match(mongoose.connection.name, /^lms_test_/); await mongoose.connection.dropDatabase(); await mongoose.disconnect();
  }
});
