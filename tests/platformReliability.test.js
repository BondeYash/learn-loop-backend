import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import mongoose from "mongoose";
import nodemailer from "nodemailer";
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
import { requestPasswordReset } from "../services/authService.js";

test("student progress, shared-proxy sign-in budgets and failed recovery mail (isolated HTTP/MongoDB)", { timeout: 60000 }, async t => {
  await mongoose.connect(`mongodb://127.0.0.1:${process.env.TEST_MONGO_PORT || 27018}/lms_platform_${crypto.randomBytes(6).toString("hex")}`);
  await Promise.all([User, Session, Course, Category, Module, Lesson, Enrollment, Progress, VideoAsset].map(model => model.init()));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, cookie, method = "GET", body) => {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const password = crypto.randomBytes(16).toString("hex"), email = `learner-${crypto.randomBytes(6).toString("hex")}@example.invalid`;
  try {
    const teacher = await User.create({ name: "Teacher", email: `teacher-${email}`, password, role: "instructor" });
    const learner = await User.create({ name: "Learner", email, password, role: "student" });
    const category = await Category.create({ name: "Platform audit" });
    const course = await Course.create({ title: "Available lesson progress", description: "Synthetic course", category: category._id, instructor: teacher._id, isPublished: true });
    const module = await Module.create({ course: course._id, title: "Study", order: 0 });
    const lessons = await Lesson.create([0, 1].map(order => ({ course: course._id, module: module._id, title: `Text ${order}`, contentType: "text", content: "Synthetic learning material", order })));
    const draft = await Lesson.create({ course: course._id, module: module._id, title: "Unfinished upload", contentType: "video", order: 2 });
    await Enrollment.create({ course: course._id, student: learner._id, assignedBy: teacher._id });
    const cookie = (await call("/auth/login", null, "POST", { email, password })).cookie;
    await t.test("anonymous session checks never exhaust sign-in attempts for other learners", async () => {
      for (let i = 0; i < 35; i++) assert.equal((await call("/auth/me")).status, 401);
      assert.equal((await call("/auth/login", null, "POST", { email, password })).status, 200);
      assert.equal((await call("/auth/login", null, "POST", { email, password: { unexpected: true } })).status, 400);
    });
    await t.test("unfinished lessons stay out of completion; concurrent first completions are retained", async () => {
      const opened = (await call(`/courses/${course._id}`, cookie)).body.data;
      assert.equal(opened.modules[0].lessons.length, 2); assert.equal(opened.progress.totalLessons, 2);
      assert.equal((await call(`/lessons/${draft._id}/complete`, cookie, "POST", {})).status, 409);
      const answers = await Promise.all(lessons.map(lesson => call(`/lessons/${lesson._id}/complete`, cookie, "POST", {})));
      assert.ok(answers.every(answer => answer.status === 200));
      const saved = await Progress.findOne({ course: course._id, student: learner._id });
      assert.equal(saved.completedLessons.length, 2); assert.equal(saved.percentage, 100);
      assert.equal((await call(`/courses/${course._id}/progress`, cookie)).body.data.progress.percentage, 100);
      const asset = await VideoAsset.create({ owner: teacher._id, lesson: draft._id, course: course._id, fingerprint: "audit-video", size: 2048, chunkSize: 0, chunkCount: 0, status: "ready", expiresAt: new Date(Date.now() + 86400000) });
      await Lesson.updateOne({ _id: draft._id }, { video: asset._id });
      assert.equal((await call(`/courses/${course._id}/progress`, cookie)).body.data.progress.percentage, 67);
      const extra = await Course.create({ title: "Not enrolled", description: "Synthetic other course", category: category._id, instructor: teacher._id, isPublished: true });
      const library = (await call("/courses?enrolled=true", cookie)).body.data.courses;
      assert.deepEqual(library.map(item => item._id), [String(course._id)]); assert.ok(!library.some(item => item._id === String(extra._id)));
    });
    await t.test("a failed old reset delivery does not delete a newer reset link", async () => {
      const names = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"], previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
      const original = nodemailer.createTransport; let rejectOld, entered;
      const started = new Promise(resolve => { entered = resolve; });
      let calls = 0;
      try {
        for (const name of names) process.env[name] = "synthetic-fixture";
        nodemailer.createTransport = options => {
          assert.equal(options.connectionTimeout, 8000); assert.equal(options.socketTimeout, 10000);
          return { close() {}, sendMail: async () => { if (++calls === 1) { entered(); return new Promise((_, reject) => { rejectOld = reject; }); } } };
        };
        const old = requestPasswordReset(email); const failure = assert.rejects(old, error => error.statusCode === 503 && !error.message.includes("PRIVATE_SMTP_ERROR"));
        await started; await requestPasswordReset(email);
        const newer = (await User.findById(learner._id).select("+resetPasswordToken")).resetPasswordToken;
        rejectOld(new Error("PRIVATE_SMTP_ERROR")); await failure;
        assert.equal((await User.findById(learner._id).select("+resetPasswordToken")).resetPasswordToken, newer);
      } finally {
        nodemailer.createTransport = original;
        for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
      }
    });
    await t.test("readiness reports disconnection promptly without spending an auth budget", async () => {
      assert.equal((await call("/ready")).status, 200);
      const uri = mongoose.connection.host, name = mongoose.connection.name;
      await mongoose.disconnect();
      try {
        assert.equal((await call("/health", cookie)).status, 200);
        const unavailable = await call("/ready", cookie); assert.equal(unavailable.status, 503); assert.equal(unavailable.body.data.databaseReady, false);
      } finally { await mongoose.connect(`mongodb://${uri}:${process.env.TEST_MONGO_PORT || 27018}/${name}`); }
    });
  } finally { await new Promise(resolve => server.close(resolve)); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
});
