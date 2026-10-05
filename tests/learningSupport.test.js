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
import Progress from "../models/Progress.js";
import Enrollment from "../models/Enrollment.js";
import VideoAsset from "../models/VideoAsset.js";
import { PracticalTask, PracticalRecord, CourseQuestion } from "../models/LearningSupport.js";
test("private learning support and honest resume/progress (isolated MongoDB + HTTP)", { timeout: 90000 }, async (t) => {
  process.env.NODE_ENV = "test";
  await mongoose.connect(`mongodb://127.0.0.1:${process.env.TEST_MONGO_PORT || 27018}/lms_test_${crypto.randomBytes(6).toString("hex")}`, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([User, Session, Course, Category, Module, Lesson, Progress, Enrollment, VideoAsset, PracticalTask, PracticalRecord, CourseQuestion].map((m) => m.init()));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, who, method = "GET", body) => { const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(who?.cookie ? { cookie: who.cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json(), cookie: r.headers.get("set-cookie")?.split(";")[0] }; };
  try {
    const users = {};
    for (const [name, role] of [["owner", "instructor"], ["other", "instructor"], ["student", "student"], ["second", "student"], ["unassigned", "student"], ["admin", "admin"]]) { const password = crypto.randomBytes(24).toString("hex"), user = await User.create({ name, role, email: `${name}@example.invalid`, password }); users[name] = { id: user._id, cookie: (await call("/auth/login", null, "POST", { email: user.email, password })).cookie }; }
    const category = await Category.create({ name: "Synthetic practice" }), course = await Course.create({ title: "Synthetic general course", description: "Only synthetic fixtures", instructor: users.owner.id, category: category._id, isPublished: true }), module = await Module.create({ course: course._id, title: "Synthetic chapter", order: 0 });
    const lesson = await Lesson.create({ course: course._id, module: module._id, title: "Synthetic text lesson", contentType: "text", content: "Author-owned fixture", order: 0 }), later = await Lesson.create({ course: course._id, module: module._id, title: "Synthetic later lesson", contentType: "text", content: "Later fixture", order: 1 });
    for (const name of ["student", "second"]) await Enrollment.create({ student: users[name].id, course: course._id, assignedBy: users.owner.id });
    const tasks = `/courses/${course._id}/practicals`, questions = `/courses/${course._id}/questions`, visit = `/lessons/${lesson._id}/visit`;
    let task, record, question;
    await t.test("existing public endpoints remain anonymous and owner/student access stays isolated", async () => {
      assert.equal((await call("/health", null)).status, 200); assert.equal((await call("/public/courses", null)).status, 200);
      for (const path of [tasks, questions]) { assert.equal((await call(path, null)).status, 401); assert.equal((await call(path, users.unassigned)).status, 403); assert.equal((await call(path, users.other)).status, 403); }
      const values = { title: "Synthetic practical", instructions: "PRIVATE_AUTHOR_INSTRUCTIONS", lesson: String(lesson._id), checklist: ["Synthetic step A", "Synthetic step B"], active: true };
      assert.equal((await call(tasks, users.student, "POST", values)).status, 403); assert.equal((await call(tasks, users.other, "POST", values)).status, 403);
      assert.equal((await call(tasks, users.owner, "POST", { ...values, checklist: Array(21).fill("step") })).status, 400);
      assert.equal((await call(tasks, users.owner, "POST", { ...values, lesson: new mongoose.Types.ObjectId().toString() })).status, 400);
      const made = await call(tasks, users.owner, "POST", { ...values, student: users.second.id, completed: true }); assert.equal(made.status, 200); task = made.body.data.task;
      assert.equal((await call(tasks, users.admin)).body.data.tasks.length, 1); assert.equal((await call(`/public/courses/${course.slug}/practicals`, null)).status, 404);
    });
    await t.test("practical text/checklist is self-reported, privately scoped, versioned and retry-safe without lesson completion", async () => {
      const body = { taskVersion: task.version, revision: 0, checked: [true, true], response: "PRIVATE_STUDENT_RESPONSE", completed: true, requestId: crypto.randomUUID(), student: users.second.id, score: 100 };
      assert.equal((await call(`/practicals/${task.id}/record`, users.student, "POST", { ...body, checked: [true, false] })).status, 400);
      const saved = await call(`/practicals/${task.id}/record`, users.student, "POST", body); assert.equal(saved.status, 200); record = saved.body.data.record; assert.equal(record.completed, true);
      const retry = await call(`/practicals/${task.id}/record`, users.student, "POST", body); assert.equal(retry.body.data.record.id, record.id); assert.equal(retry.body.data.record.revision, 1);
      assert.equal(await PracticalRecord.countDocuments({ task: task.id, student: users.student.id }), 1); assert.equal(await Progress.countDocuments({ course: course._id }), 0);
      assert.equal((await call(tasks, users.second)).body.data.tasks[0].record, null);
      assert.equal((await call(`/courses/${course._id}/practical-records`, users.student)).status, 403); assert.equal((await call(`/courses/${course._id}/practical-records`, users.other)).status, 403);
      const owner = await call(`/courses/${course._id}/practical-records`, users.owner); assert.equal(owner.body.data.records[0].response, body.response); assert.ok(!JSON.stringify(owner.body).includes("student@example.invalid"));
      const updated = await call(`${tasks}/${task.id}`, users.admin, "PUT", { title: task.title, instructions: "Reviewed new instructions", lesson: null, checklist: [], active: true, version: task.version }); assert.equal(updated.status, 200);
      assert.equal((await call(`/practicals/${task.id}/record`, users.student, "POST", { ...body, requestId: crypto.randomUUID() })).status, 409);
      const latest = (await call(tasks, users.student)).body.data.tasks[0]; assert.equal(latest.version, 2); assert.equal(latest.record.taskVersion, 1);
    });
    let latestRevision;
    await t.test("resume writes do not complete lessons, survive reload, reject stale tabs and are idempotent", async () => {
      const body = { position: 0, revision: 0, requestId: crypto.randomUUID() };
      const starts = await Promise.all(Array.from({ length: 4 }, () => call(visit, users.student, "POST", body))); starts.forEach((r) => assert.equal(r.status, 200));
      const saved = starts[0].body.data.progress; assert.equal(saved.resumeRevision, 1); assert.deepEqual(saved.completedLessons, []); assert.equal(saved.percentage, 0); assert.equal(saved.totalLessons, 2);
      assert.equal((await call(`/courses/${course._id}/progress`, users.student)).body.data.progress.resume.lesson, String(lesson._id));
      assert.equal((await call(visit, users.student, "POST", { position: 20, revision: 1, requestId: crypto.randomUUID() })).status, 400);
      const next = await call(`/lessons/${later._id}/visit`, users.student, "POST", { position: 0, revision: 1, requestId: crypto.randomUUID() }); assert.equal(next.status, 200); latestRevision = next.body.data.progress.resumeRevision;
      assert.equal((await call(visit, users.student, "POST", { position: 0, revision: 1, requestId: crypto.randomUUID() })).status, 409);
      const listed = (await call("/courses", users.student)).body.data.courses[0]; assert.equal(listed.progress.resume.lesson, String(later._id)); assert.equal(listed.progress.completedCount, 0); assert.equal(listed.access.status, "active");
      const complete = await call(`/lessons/${lesson._id}/complete`, users.student, "POST", {}); assert.equal(complete.body.data.progress.completedCount, 1);
      await call(`/lessons/${lesson._id}/complete`, users.student, "POST", {}); assert.equal((await Progress.findOne({ student: users.student.id, course: course._id })).completedLessons.length, 1);
    });
    await t.test("video positions are bounded; unavailable and deleted resume targets disappear without damaging completion", async () => {
      const videoLesson = await Lesson.create({ course: course._id, module: module._id, title: "Synthetic MP4", order: 2 });
      const asset = await VideoAsset.create({ owner: users.owner.id, course: course._id, lesson: videoLesson._id, fingerprint: "support-fixture", filename: "fixture.mp4", size: 200, chunkSize: 0, chunkCount: 0, duration: 30, status: "ready", uploadMode: "direct", storageProvider: "r2", objectKey: "synthetic-only", expiresAt: new Date(Date.now() + 3600000) });
      await Lesson.updateOne({ _id: videoLesson._id }, { video: asset._id }); const path = `/lessons/${videoLesson._id}/visit`;
      assert.equal((await call(path, users.student, "POST", { position: 31, revision: latestRevision, requestId: crypto.randomUUID() })).status, 400);
      const saved = await call(path, users.student, "POST", { position: 12, revision: latestRevision, requestId: crypto.randomUUID() }); assert.equal(saved.status, 200); assert.equal(saved.body.data.progress.resume.position, 12); latestRevision = saved.body.data.progress.resumeRevision;
      await VideoAsset.updateOne({ _id: asset._id }, { status: "failed" }); assert.equal((await call(`/courses/${course._id}/progress`, users.student)).body.data.progress.resume, null);
      await Lesson.deleteOne({ _id: videoLesson._id }); await Lesson.deleteOne({ _id: later._id }); const progress = (await call(`/courses/${course._id}/progress`, users.student)).body.data.progress; assert.equal(progress.resume, null); assert.equal(progress.completedCount, 1); assert.equal(progress.totalLessons, 1); assert.equal(progress.percentage, 100);
      assert.equal((await call(path, users.student, "POST", { position: 0, revision: latestRevision, requestId: crypto.randomUUID() })).status, 404);
    });
    await t.test("questions and owner replies stay private, duplicate requests do not duplicate threads or replies, and resolve/reopen transitions are guarded", async () => {
      const body = { text: "PRIVATE_STUDENT_DOUBT", lesson: String(lesson._id), requestId: crypto.randomUUID(), student: users.second.id };
      assert.equal((await call(questions, users.owner, "POST", body)).status, 403);
      const made = await Promise.all([call(questions, users.student, "POST", body), call(questions, users.student, "POST", body)]); made.forEach((r) => assert.equal(r.status, 200)); question = made[0].body.data.question; assert.equal(made[1].body.data.question.id, question.id); assert.equal(question.status, "pending");
      assert.equal((await call(questions, users.second)).body.data.questions.length, 0); assert.ok(!JSON.stringify(made[0].body).includes("student@example.invalid")); assert.ok(!JSON.stringify(made[0].body).includes(String(users.student.id)));
      const reply = { text: "PRIVATE_OWNER_REPLY", version: question.version, requestId: crypto.randomUUID() }, path = `/course-questions/${question.id}/replies`;
      assert.equal((await call(path, users.other, "POST", reply)).status, 403); assert.equal((await call(path, users.student, "POST", reply)).status, 403);
      const responses = await Promise.all([call(path, users.owner, "POST", reply), call(path, users.owner, "POST", reply)]); responses.forEach((r) => assert.equal(r.status, 200)); question = responses[0].body.data.question; assert.equal(question.replies.length, 1); assert.equal(question.status, "answered");
      for (const endpoint of ["/public/courses", `/public/courses/${course._id}`]) {
        const discovered = await call(endpoint); assert.equal(discovered.status, 200);
        const metadata = JSON.stringify(discovered.body);
        for (const secret of [body.text, reply.text, "PRIVATE_STUDENT_RESPONSE", "student@example.invalid", String(users.student.id)]) assert.ok(!metadata.includes(secret), `public metadata exposed ${secret}`);
      }
      const status = `/course-questions/${question.id}/status`;
      assert.equal((await call(status, users.second, "PUT", { resolved: true, version: question.version })).status, 404);
      assert.equal((await call(status, users.student, "PUT", { resolved: true, version: 1 })).status, 409);
      const resolved = await call(status, users.student, "PUT", { resolved: true, version: question.version }); assert.equal(resolved.body.data.question.status, "resolved"); question = resolved.body.data.question;
      assert.equal((await call(path, users.admin, "POST", { ...reply, version: question.version, requestId: crypto.randomUUID() })).status, 409);
      assert.equal((await call(status, users.student, "PUT", { resolved: true, version: question.version })).body.data.question.version, question.version);
      assert.equal((await call(status, users.student, "PUT", { resolved: false, version: question.version })).body.data.question.status, "answered");
      assert.equal((await call(questions+'?page=0', users.student)).status, 400);
    });
    await t.test("task/thread caps, reply limits, pagination and question request rates are bounded", async () => {
      await PracticalTask.insertMany(Array.from({ length: 38 }, (_, i) => ({ course: course._id, slot: i + 1, title: "Synthetic empty-content fixture", instructions: "Synthetic instructions", checklist: [], active: true })));
      const body = { title: "Synthetic last task", instructions: "Synthetic instructions", checklist: [], active: true };
      const created = await Promise.all([call(tasks, users.owner, "POST", body), call(tasks, users.owner, "POST", body)]); assert.equal(created.filter((r) => r.status === 200).length, 1); assert.ok(created.some((r) => r.status === 409)); assert.equal(await PracticalTask.countDocuments({ course: course._id }), 40);
      let thread = await CourseQuestion.findById(question.id);
      for (let i = 0; i < 9; i++) { const r = await call(`/course-questions/${question.id}/replies`, users.owner, "POST", { text: `Synthetic follow-up ${i}`, requestId: crypto.randomUUID(), version: thread.version }); assert.equal(r.status, 200); thread = await CourseQuestion.findById(question.id); }
      assert.equal((await call(`/course-questions/${question.id}/replies`, users.owner, "POST", { text: "Beyond limit", requestId: crypto.randomUUID(), version: thread.version })).status, 409);
      await CourseQuestion.insertMany(Array.from({ length: 50 }, (_, i) => ({ course: course._id, student: users.second.id, slot: i, text: "Synthetic bounded thread fixture", requestId: crypto.randomUUID() })));
      const listed = (await call(questions, users.second)).body.data; assert.equal(listed.questions.length, 20); assert.equal(listed.total, 50); assert.equal((await call(questions+'?page=2', users.second)).body.data.questions.length, 20);
      for (let i = 0; i < 10; i++) assert.equal((await call(questions, users.second, "POST", { text: "Beyond retained limit", requestId: crypto.randomUUID() })).status, 409);
      assert.equal((await call(questions, users.second, "POST", { text: "Rate limit", requestId: crypto.randomUUID() })).status, 429);
    });
    await t.test("fresh revocation, unpaid/unpublished/archived courses and expired sessions block support and resume", async () => {
      const operations = [[tasks,"GET"], [questions,"GET"], [questions,"POST",{text:"Question",requestId:crypto.randomUUID()}], [visit,"POST",{position:0,revision:latestRevision,requestId:crypto.randomUUID()}], [`/practicals/${task.id}/record`,"POST",{taskVersion:2,revision:0,checked:[],response:"",completed:false,requestId:crypto.randomUUID()}]];
      const denied = async (status) => { for (const [p,m,b] of operations) assert.equal((await call(p,users.student,m,b)).status,status); };
      await Enrollment.updateOne({ student: users.student.id, course: course._id }, { $unset: { assignedBy: 1 }, $set: { publicFreeEnrollment: true } }); await denied(403);
      await Course.updateOne({ _id: course._id }, { visibility: "public", price: 100 }); await denied(402);
      await Course.updateOne({ _id: course._id }, { price: 0, isPublished: false }); await denied(403);
      await Course.updateOne({ _id: course._id }, { isPublished: true, archivedAt: new Date() }); await denied(410);
      await Course.updateOne({ _id: course._id }, { archivedAt: null }); await Session.deleteMany({ user: users.student.id }); await denied(401);
    });
    await t.test("course purge removes practical and private-thread records", async () => { const { purgeCourse } = await import("../services/courseService.js"); await purgeCourse(course._id); for (const model of [PracticalTask, PracticalRecord, CourseQuestion, Progress]) assert.equal(await model.countDocuments({ course: course._id }), 0); });
  } finally { await new Promise((resolve) => server.close(resolve)); assert.match(mongoose.connection.name, /^lms_test_/); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
});
