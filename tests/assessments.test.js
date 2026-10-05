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
import Enrollment from "../models/Enrollment.js";
import Progress from "../models/Progress.js";
import Assessment from "../models/Assessment.js";
import AssessmentAttempt from "../models/AssessmentAttempt.js";
import { paymentOrderModel } from "../models/PaymentOrder.js";
import { stripeMode } from "../services/stripeMode.js";

test("authored assessments and attempts preserve entitlement, keys, server timing and immutable results (isolated MongoDB + HTTP)", { timeout: 90000 }, async (t) => {
  process.env.NODE_ENV = "test";
  await mongoose.connect(`mongodb://127.0.0.1:${process.env.TEST_MONGO_PORT || 27018}/lms_test_${crypto.randomBytes(6).toString("hex")}`, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([User, Session, Course, Category, Module, Enrollment, Progress, Assessment, AssessmentAttempt, paymentOrderModel(stripeMode())].map((m) => m.init()));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, who, method = "GET", body) => {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(who?.cookie ? { cookie: who.cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const hidden = (response) => { const body = JSON.stringify(response.body); for (const marker of ["correctIndex", "explanation", "snapshot", "ANSWER_KEY_SECRET"]) assert.ok(!body.includes(marker), `Key leakage: ${marker}`); };
  try {
    const users = {};
    for (const [name, role] of [["teacher", "instructor"], ["other", "instructor"], ["student", "student"], ["second", "student"], ["admin", "admin"]]) {
      const password = crypto.randomBytes(24).toString("hex"), user = await User.create({ name, role, email: `${name}@example.invalid`, password });
      users[name] = { id: user._id, cookie: (await call("/auth/login", null, "POST", { email: user.email, password })).cookie };
    }
    const category = await Category.create({ name: "Synthetic generic exam" });
    const course = await Course.create({ title: "Synthetic general course", description: "No official question content", category: category._id, instructor: users.teacher.id, isPublished: true });
    const chapter = await Module.create({ course: course._id, title: "Synthetic chapter", order: 0 });
    for (const name of ["student", "second"]) await Enrollment.create({ student: users[name].id, course: course._id, assignedBy: users.teacher.id });
    const body = { title: "Synthetic quiz", kind: "quiz", module: String(chapter._id), status: "draft", durationMinutes: null, questions: [] };
    const questions = [{ prompt: "Synthetic tagged question", options: ["Synthetic A", "Synthetic B"], correctIndex: 1, explanation: "ANSWER_KEY_SECRET: authored explanation", topic: "Explicit topic" }, { prompt: "Synthetic untagged question", options: ["Synthetic X", "Synthetic Y"], correctIndex: 0, explanation: "ANSWER_KEY_SECRET: another explanation", topic: "" }];
    const list = `/courses/${course._id}/assessments`; let quiz, attempt;
    await t.test("draft authoring is owner/admin-only and validates course/chapter, limits and publication accuracy", async () => {
      assert.equal((await call(list, null, "POST", body)).status, 401);
      assert.equal((await call(list, users.student, "POST", body)).status, 403);
      assert.equal((await call(list, users.other, "POST", body)).status, 403);
      const made = await call(list, users.teacher, "POST", { ...body, student: users.second.id, course: "bad", version: 99 });
      assert.equal(made.status, 201); quiz = made.body.data.assessment; assert.equal(quiz.version, 1); assert.equal(quiz.courseId, String(course._id));
      assert.equal((await call(list + "/manage", users.other)).status, 403);
      assert.equal((await call(list + "/manage", users.student)).status, 403);
      assert.equal((await call(list + "/manage", users.admin)).body.data.assessments.length, 1);
      assert.equal((await call(list, users.student)).body.data.assessments.length, 0);
      assert.equal((await call(`/assessments/${quiz.id}/attempts`, users.student, "POST", {})).status, 404);
      for (const extra of [{ status: "published" }, { questions: Array(41).fill(questions[0]) }, { kind: "mock", durationMinutes: null }, { durationMinutes: 0 }, { module: new mongoose.Types.ObjectId().toString() }]) assert.equal((await call(list, users.teacher, "POST", { ...body, ...extra })).status, 400);
      assert.equal((await call(list, users.teacher, "POST", { ...body, status: "published", questions: [{ ...questions[0], explanation: "" }] })).status, 400);
      assert.equal((await call(list, users.teacher, "POST", { ...body, status: "published", questions: [{ ...questions[0], options: ["Same", "same"] }] })).status, 400);
      const published = await call(`${list}/${quiz.id}`, users.admin, "PUT", { ...body, questions, status: "published", version: quiz.version });
      assert.equal(published.status, 200); quiz = published.body.data.assessment; assert.equal(quiz.questionCount, 2);
      assert.equal((await call(`${list}/${quiz.id}`, users.teacher, "PUT", { ...body, version: 1 })).status, 409);
    });
    await t.test("student list/start/answer/read/history never leak keys, and concurrent starts resume one attempt", async () => {
      const available = await call(list, users.student); assert.equal(available.status, 200); hidden(available);
      const starts = await Promise.all(Array.from({ length: 6 }, () => call(`/assessments/${quiz.id}/attempts`, users.student, "POST", { score: 100, startedAt: "2099-01-01", answers: [1, 0] })));
      starts.forEach((r) => { assert.equal(r.status, 200); hidden(r); });
      assert.equal(new Set(starts.map((r) => r.body.data.attempt.id)).size, 1); attempt = starts[0].body.data.attempt;
      assert.deepEqual(attempt.answers, [null, null]); assert.equal(attempt.deadline, null);
      assert.equal(await AssessmentAttempt.countDocuments({ assessment: quiz.id, student: users.student.id }), 1);
      assert.equal((await AssessmentAttempt.findById(attempt.id)).snapshot, undefined);
      for (const answer of [{ questionIndex: -1, optionIndex: 0 }, { questionIndex: 2, optionIndex: 0 }, { questionIndex: 0, optionIndex: 9 }, { questionIndex: "0", optionIndex: 1 }, { questionIndex: 0 }]) assert.equal((await call(`/assessment-attempts/${attempt.id}/answers`, users.student, "PUT", answer)).status, 400);
      const saved = await call(`/assessment-attempts/${attempt.id}/answers`, users.student, "PUT", { questionIndex: 0, optionIndex: 0, correctIndex: 0, score: 100 }); assert.equal(saved.status, 200); hidden(saved);
      const read = await call(`/assessment-attempts/${attempt.id}`, users.student); hidden(read); assert.deepEqual(read.body.data.attempt.answers, [0, null]);
      hidden(await call(`/courses/${course._id}/assessment-attempts`, users.student));
      for (const [method, suffix, payload] of [["GET", "", undefined], ["PUT", "/answers", { questionIndex: 0, optionIndex: 1 }], ["POST", "/submit", {}]]) assert.equal((await call(`/assessment-attempts/${attempt.id}${suffix}`, users.second, method, payload)).status, 404);
      assert.equal((await call(`/assessment-attempts/${attempt.id}`, users.teacher)).status, 403);
    });
    await t.test("editing published content does not alter active snapshots; scoring ignores forged client values and submit is idempotent", async () => {
      const changed = await call(`${list}/${quiz.id}`, users.teacher, "PUT", { ...body, status: "draft", version: quiz.version, questions: [{ ...questions[0], correctIndex: 0 }] }); assert.equal(changed.status, 200); quiz = changed.body.data.assessment;
      const results = await Promise.all(Array.from({ length: 5 }, () => call(`/assessment-attempts/${attempt.id}/submit`, users.student, "POST", { answers: [1, 0], result: { correct: 2 }, deadline: "2099-01-01" })));
      assert.ok(results.every((r) => r.status === 200));
      const result = results[0].body.data.attempt; assert.equal(result.status, "submitted"); assert.equal(result.result.total, 2); assert.equal(result.result.correct, 0); assert.equal(result.result.answered, 1);
      assert.equal(result.review[0].correctIndex, 1); assert.ok(result.review[0].explanation.includes("ANSWER_KEY_SECRET")); assert.equal(result.version, 2);
      assert.equal(new Set(results.map((r) => r.body.data.attempt.submittedAt)).size, 1);
      assert.equal((await call(`/assessment-attempts/${attempt.id}/answers`, users.student, "PUT", { questionIndex: 0, optionIndex: 1 })).status, 409);
      const history = (await call(`/courses/${course._id}/assessment-attempts`, users.student)).body.data;
      assert.equal(history.total, 1); assert.equal(history.weakTopics.length, 1); assert.equal(history.weakTopics[0].topic, "Explicit topic"); assert.equal(history.weakTopics[0].percentage, 0); hidden({ body: history });
      assert.equal(await Progress.countDocuments({ course: course._id }), 0);
    });
    let mock;
    await t.test("mock timer uses server time, refresh persists answers and late answers are refused before exposing timed-out results", async () => {
      const made = await call(list, users.teacher, "POST", { ...body, title: "Synthetic timed mock", kind: "mock", module: null, durationMinutes: 1, status: "published", questions }); assert.equal(made.status, 201); mock = made.body.data.assessment;
      attempt = (await call(`/assessments/${mock.id}/attempts`, users.student, "POST", {})).body.data.attempt;
      assert.equal(Date.parse(attempt.deadline) - Date.parse(attempt.startedAt), 60000); hidden({ body: attempt });
      assert.equal((await call(`/assessment-attempts/${attempt.id}/answers`, users.student, "PUT", { questionIndex: 0, optionIndex: 1 })).status, 200);
      assert.deepEqual((await call(`/assessment-attempts/${attempt.id}`, users.student)).body.data.attempt.answers, [1, null]);
      await AssessmentAttempt.updateOne({ _id: attempt.id }, { deadline: new Date(Date.now() - 1000) });
      assert.equal((await call(`/assessment-attempts/${attempt.id}/answers`, users.student, "PUT", { questionIndex: 1, optionIndex: 0, deadline: "2099-01-01" })).status, 409);
      const result = (await call(`/assessment-attempts/${attempt.id}`, users.student)).body.data.attempt;
      assert.equal(result.status, "timed_out"); assert.equal(result.result.percentage, 50); assert.deepEqual(result.answers, [1, null]);
      assert.equal((await call(`/assessment-attempts/${attempt.id}/submit`, users.student, "POST", {})).body.data.attempt.submittedAt, result.submittedAt);
    });
    await t.test("answer/submit races preserve accepted answers in the scored result; clear answers and fresh attempts work", async () => {
      attempt = (await call(`/assessments/${mock.id}/attempts`, users.student, "POST", {})).body.data.attempt;
      await call(`/assessment-attempts/${attempt.id}/answers`, users.student, "PUT", { questionIndex: 0, optionIndex: 1 });
      assert.deepEqual((await call(`/assessment-attempts/${attempt.id}/answers`, users.student, "PUT", { questionIndex: 0, optionIndex: null })).body.data.attempt.answers, [null, null]);
      const [answer, submit] = await Promise.all([call(`/assessment-attempts/${attempt.id}/answers`, users.student, "PUT", { questionIndex: 1, optionIndex: 0 }), call(`/assessment-attempts/${attempt.id}/submit`, users.student, "POST", {})]);
      assert.equal(submit.status, 200); assert.ok([200, 409].includes(answer.status));
      const final = (await call(`/assessment-attempts/${attempt.id}`, users.student)).body.data.attempt;
      assert.equal(final.result.correct, final.answers[1] === 0 ? 1 : 0);
      if (answer.status === 200) assert.equal(final.answers[1], 0);
    });
    await t.test("database uniqueness enforces the course and learner limits under concurrent creation", async () => {
      for (let i = 0; i < 37; i++) assert.equal((await call(list, users.teacher, "POST", { ...body, title: `Synthetic empty draft ${i}` })).status, 201);
      const creates = await Promise.all(Array.from({ length: 4 }, (_, i) => call(list, users.teacher, "POST", { ...body, title: `Concurrent synthetic draft ${i}` })));
      assert.equal(creates.filter((r) => r.status === 201).length, 1); assert.ok(creates.every((r) => [201, 409].includes(r.status))); assert.equal(await Assessment.countDocuments({ course: course._id }), 40);
      await AssessmentAttempt.insertMany(Array.from({ length: 100 }, (_, i) => ({ assessment: mock.id, student: users.second.id, course: course._id, attemptNumber: i + 1, status: "submitted", startedAt: new Date(), submittedAt: new Date(), snapshot: { title: mock.title, kind: "mock", version: 1, durationMinutes: 1, questions }, answers: [null, null], result: { correct: 0, answered: 0, total: 2, percentage: 0, topics: [] } })));
      assert.equal((await call(`/assessments/${mock.id}/attempts`, users.second, "POST", {})).status, 409);
    });
    await t.test("private/public nomination, paid entitlement, course archive, publication and expired sessions protect every endpoint", async () => {
      const paths = [list, `/courses/${course._id}/assessment-attempts`, `/assessment-attempts/${attempt.id}`];
      const assertDenied = async (status) => {
        for (const path of paths) assert.equal((await call(path, users.student)).status, status);
        assert.equal((await call(`/assessments/${mock.id}/attempts`, users.student, "POST", {})).status, status);
        assert.equal((await call(`/assessment-attempts/${attempt.id}/submit`, users.student, "POST", {})).status, status);
        assert.equal((await call(`/assessment-attempts/${attempt.id}/answers`, users.student, "PUT", { questionIndex: 0, optionIndex: 0 })).status, status);
      };
      await Enrollment.updateOne({ student: users.student.id, course: course._id }, { $unset: { assignedBy: 1 }, $set: { publicFreeEnrollment: true } });
      await assertDenied(403); // A public flag cannot open a private course.
      await Course.updateOne({ _id: course._id }, { visibility: "public" }); assert.equal((await call(list, users.student)).status, 200);
      await Course.updateOne({ _id: course._id }, { price: 100 }); await assertDenied(402);
      await Course.updateOne({ _id: course._id }, { price: 0, isPublished: false }); await assertDenied(403);
      await Course.updateOne({ _id: course._id }, { isPublished: true, archivedAt: new Date() }); await assertDenied(410);
      await Course.updateOne({ _id: course._id }, { archivedAt: null });
      await Session.deleteMany({ user: users.student.id }); await assertDenied(401);
      assert.equal((await call(`/public/courses/${course.slug}/assessments`, null)).status, 404);
    });
    await t.test("chapter removal prevents new attempts and course purge removes assessment records", async () => {
      assert.equal((await call(`${list}/${quiz.id}`, users.teacher, "PUT", { ...body, questions, status: "published", version: quiz.version })).status, 200);
      await Module.deleteOne({ _id: chapter._id });
      assert.equal((await call(list, users.second)).body.data.assessments.some((a) => a.kind === "quiz"), false);
      assert.equal((await call(`/assessments/${quiz.id}/attempts`, users.second, "POST", {})).status, 404);
      const { purgeCourse } = await import("../services/courseService.js"); await purgeCourse(course._id);
      assert.equal(await Assessment.countDocuments({ course: course._id }), 0); assert.equal(await AssessmentAttempt.countDocuments({ course: course._id }), 0);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve)); assert.match(mongoose.connection.name, /^lms_test_/); await mongoose.connection.dropDatabase(); await mongoose.disconnect();
  }
});
