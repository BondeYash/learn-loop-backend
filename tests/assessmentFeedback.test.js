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

test("immediate mock feedback preserves first choices, key privacy, timers and original attempt rules (isolated MongoDB + HTTP)", { timeout: 90000 }, async (t) => {
  await mongoose.connect(`mongodb://127.0.0.1:${process.env.TEST_MONGO_PORT || 27018}/lms_feedback_test_${crypto.randomBytes(6).toString("hex")}`, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([User, Session, Course, Category, Module, Enrollment, Progress, Assessment, AssessmentAttempt].map((m) => m.init()));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const call = async (path, user, method = "GET", body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { "Content-Type": "application/json", ...(user ? { cookie: user.cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json(), cookie: r.headers.get("set-cookie")?.split(";")[0] };
  };
  const users = {}, questions = [
    { prompt: "Synthetic first", options: ["Wrong A", "Correct A"], correctIndex: 1, explanation: "PRIVATE_EXPLANATION_A", topic: "Tag A" },
    { prompt: "Synthetic second", options: ["Correct B", "Wrong B"], correctIndex: 0, explanation: "PRIVATE_EXPLANATION_B", topic: "Tag B" },
    { prompt: "Synthetic unanswered", options: ["Wrong C", "Correct C"], correctIndex: 1, explanation: "PRIVATE_EXPLANATION_C", topic: "Tag A" },
  ];
  const privateActive = (a) => {
    assert.equal(a.status, "active"); for (const field of ["snapshot", "review", "result", "correctIndex", "explanation", "importReview"]) assert.equal(a[field], undefined);
    a.questions.forEach((q) => assert.deepEqual(Object.keys(q).sort(), ["options", "prompt", "topic"]));
    assert.ok(!JSON.stringify(a).includes("PRIVATE_EXPLANATION"));
    if (a.feedbackMode === "after_answer") { assert.equal(a.feedback.length, a.questions.length); a.answers.forEach((answer, i) => { if (answer === null) assert.equal(a.feedback[i], null); else assert.deepEqual(a.feedback[i], { correctIndex: questions[i].correctIndex, selectedIndex: answer, correct: answer === questions[i].correctIndex }); }); }
    else assert.equal(a.feedback, undefined);
  };
  try {
    for (const [name, role] of [["owner", "instructor"], ["admin", "admin"], ["student", "student"], ["second", "student"]]) {
      const password = crypto.randomBytes(20).toString("hex"), user = await User.create({ name, role, email: `${name}@feedback-fixture.invalid`, password });
      users[name] = { id: user._id, cookie: (await call("/auth/login", null, "POST", { email: user.email, password })).cookie };
    }
    const category = await Category.create({ name: "Synthetic feedback" });
    const course = await Course.create({ title: "Synthetic feedback course", description: "Local test", category: category._id, instructor: users.owner.id, isPublished: true });
    const chapter = await Module.create({ course: course._id, title: "Synthetic chapter", order: 0 });
    await Enrollment.insertMany(["student", "second"].map((name) => ({ course: course._id, student: users[name].id, assignedBy: users.owner.id })));
    const list = `/courses/${course._id}/assessments`, body = { title: "Synthetic feedback mock", kind: "mock", module: null, durationMinutes: 30, status: "published", questions };
    const made = await call(list, users.owner, "POST", body); assert.equal(made.status, 201); let mock = made.body.data.assessment, attempt;
    const start = async (user = users.student, id = mock.id) => (await call(`/assessments/${id}/attempts`, user, "POST", { feedbackMode: "after_submit", answers: [1, 0, 1], correct: 3 })).body.data.attempt;
    const answer = (a, index, choice, user = users.student, extras = {}) => call(`/assessment-attempts/${a.id}/answers`, user, "PUT", { questionIndex: index, optionIndex: choice, ...extras });
    await t.test("owner/admin authoring and concurrent starts choose server policy without revealing any keys", async () => {
      const edit = await call(`${list}/${mock.id}`, users.admin, "PUT", { ...body, title: "Admin reviewed mock", version: mock.version }); assert.equal(edit.status, 200); mock = edit.body.data.assessment;
      assert.equal((await call(list, users.student, "POST", body)).status, 403);
      const starts = await Promise.all(Array.from({ length: 4 }, () => start())); assert.equal(new Set(starts.map((a) => a.id)).size, 1); attempt = starts[0];
      assert.equal(attempt.feedbackMode, "after_answer"); assert.deepEqual(attempt.feedback, [null, null, null]); assert.deepEqual(attempt.answers, [null, null, null]); starts.forEach(privateActive);
      const available = await call(list, users.student); assert.ok(!JSON.stringify(available).includes("correctIndex")); assert.ok(!JSON.stringify(available).includes("PRIVATE_EXPLANATION"));
      assert.equal(Date.parse(attempt.deadline) - Date.parse(attempt.startedAt), 30 * 60000);
      for (const value of [null, -1, 9, "0", undefined]) assert.equal((await answer(attempt, 0, value)).status, 400);
      assert.equal((await answer(attempt, 3, 0)).status, 400); assert.equal((await answer(attempt, "0", 0)).status, 400);
      assert.equal((await call(`/assessment-attempts/${attempt.id}`, null)).status, 401);
    });
    await t.test("incorrect first answer reveals only that question and cannot be changed/cleared; identical retries are idempotent", async () => {
      const saved = await answer(attempt, 0, 0, users.student, { feedback: [{ correctIndex: 0 }], result: { correct: 3 }, snapshot: { feedbackMode: "after_submit" } }); assert.equal(saved.status, 200); attempt = saved.body.data.attempt; privateActive(attempt);
      assert.deepEqual(attempt.feedback, [{ correctIndex: 1, selectedIndex: 0, correct: false }, null, null]); assert.equal(attempt.revision, 1);
      const retries = await Promise.all(Array.from({ length: 5 }, () => answer(attempt, 0, 0))); retries.forEach((r) => { assert.equal(r.status, 200); assert.equal(r.body.data.attempt.revision, 1); privateActive(r.body.data.attempt); });
      assert.equal((await answer(attempt, 0, 1)).status, 409); assert.equal((await answer(attempt, 0, null)).status, 400);
      const loaded = (await call(`/assessment-attempts/${attempt.id}`, users.student)).body.data.attempt; privateActive(loaded); assert.deepEqual(loaded.answers, [0, null, null]); assert.equal(loaded.deadline, attempt.deadline); assert.deepEqual((await start()).feedback, loaded.feedback);
      const read = await call(`/courses/${course._id}/assessment-attempts`, users.student); assert.ok(!JSON.stringify(read).includes("correctIndex"));
    });
    await t.test("question snapshots survive author edits; correct/incorrect/unanswered first choices determine final score", async () => {
      const edit = await call(`${list}/${mock.id}`, users.admin, "PUT", { ...body, version: mock.version, questions: questions.map((q, i) => i ? q : { ...q, correctIndex: 0, explanation: "Changed explanation" }) }); assert.equal(edit.status, 200); mock = edit.body.data.assessment;
      const saved = await answer(attempt, 1, 0); assert.equal(saved.status, 200); privateActive(saved.body.data.attempt); assert.deepEqual(saved.body.data.attempt.feedback[1], { correctIndex: 0, selectedIndex: 0, correct: true }); assert.equal(saved.body.data.attempt.feedback[2], null);
      const submits = await Promise.all(Array.from({ length: 4 }, () => call(`/assessment-attempts/${attempt.id}/submit`, users.student, "POST", { answers: [1, 0, 1], result: { correct: 3 } })));
      submits.forEach((r) => { assert.equal(r.status, 200); assert.deepEqual(r.body.data.attempt.answers, [0, 0, null]); assert.equal(r.body.data.attempt.result.correct, 1); assert.equal(r.body.data.attempt.result.answered, 2); assert.equal(r.body.data.attempt.result.total, 3); assert.equal(r.body.data.attempt.result.percentage, 33); assert.equal(r.body.data.attempt.review[0].explanation, "PRIVATE_EXPLANATION_A"); assert.equal(r.body.data.attempt.review[0].correctIndex, 1); });
      assert.equal(new Set(submits.map((r) => r.body.data.attempt.submittedAt)).size, 1); assert.equal((await answer(attempt, 2, 1)).status, 409); assert.equal(await Progress.countDocuments({ course: course._id }), 0);
    });
    await t.test("concurrent different first choices accept one winner and submission races score only accepted choices", async () => {
      // Restore authored content for an independent learner's concurrency case.
      const edit = await call(`${list}/${mock.id}`, users.owner, "PUT", { ...body, version: mock.version }); mock = edit.body.data.assessment;
      const other = await start(users.second); const writes = await Promise.all([answer(other, 0, 0, users.second), answer(other, 0, 1, users.second)]); assert.deepEqual(writes.map((r) => r.status).sort(), [200, 409]);
      const loaded = (await call(`/assessment-attempts/${other.id}`, users.second)).body.data.attempt; assert.equal(loaded.answers[0], writes.find((r) => r.status === 200).body.data.attempt.answers[0]); assert.equal(loaded.revision, 1); privateActive(loaded);
      const [saved, ended] = await Promise.all([answer(other, 1, 0, users.second), call(`/assessment-attempts/${other.id}/submit`, users.second, "POST", {})]); assert.equal(ended.status, 200); assert.ok([200, 409].includes(saved.status));
      const final = (await call(`/assessment-attempts/${other.id}`, users.second)).body.data.attempt; assert.equal(final.result.correct, Number(final.answers[0] === 1) + Number(final.answers[1] === 0)); if (saved.status === 200) assert.equal(final.answers[1], 0); assert.equal(final.answers[2], null);
    });
    await t.test("legacy attempts without policy stay editable with delayed feedback, and new mock timers still reject late answers", async () => {
      const legacy = await start(); await AssessmentAttempt.updateOne({ _id: legacy.id }, { $unset: { "snapshot.feedbackMode": 1 } });
      const loaded = (await call(`/assessment-attempts/${legacy.id}`, users.student)).body.data.attempt; assert.equal(loaded.feedbackMode, "after_submit"); privateActive(loaded);
      for (const choice of [0, 1, null]) { const r = await answer(legacy, 0, choice); assert.equal(r.status, 200); privateActive(r.body.data.attempt); assert.equal(r.body.data.attempt.answers[0], choice); }
      await call(`/assessment-attempts/${legacy.id}/submit`, users.student, "POST", {});
      const timed = await start(); await AssessmentAttempt.updateOne({ _id: timed.id }, { deadline: new Date(Date.now() - 1000) }); assert.equal((await answer(timed, 0, 1)).status, 409);
      const result = (await call(`/assessment-attempts/${timed.id}`, users.student)).body.data.attempt; assert.equal(result.status, "timed_out"); assert.equal(result.result.correct, 0); assert.equal(result.result.answered, 0); assert.deepEqual(result.answers, [null, null, null]);
    });
    await t.test("chapter quizzes preserve answer editing/clearing and reveal keys only on final submission", async () => {
      const made = await call(list, users.owner, "POST", { ...body, title: "Synthetic chapter", kind: "quiz", module: String(chapter._id), durationMinutes: null }); assert.equal(made.status, 201);
      const quiz = await start(users.student, made.body.data.assessment.id); assert.equal(quiz.feedbackMode, "after_submit"); privateActive(quiz);
      for (const choice of [0, 1, null, 1]) { const r = await answer(quiz, 0, choice); assert.equal(r.status, 200); privateActive(r.body.data.attempt); }
      const result = (await call(`/assessment-attempts/${quiz.id}/submit`, users.student, "POST", {})).body.data.attempt; assert.equal(result.result.correct, 1); assert.equal(result.result.answered, 1); assert.equal(result.review[0].correctIndex, 1);
    });
    await t.test("revealed feedback is confined to the entitled student's attempt and roles cannot bypass that access", async () => {
      for (const [method, suffix, data] of [["GET", "", undefined], ["PUT", "/answers", { questionIndex: 0, optionIndex: 1 }], ["POST", "/submit", {}]]) {
        assert.equal((await call(`/assessment-attempts/${attempt.id}${suffix}`, users.second, method, data)).status, 404);
        for (const role of ["owner", "admin"]) assert.equal((await call(`/assessment-attempts/${attempt.id}${suffix}`, users[role], method, data)).status, 403);
      }
      const active = await start(); await answer(active, 0, 0); await Enrollment.updateOne({ course: course._id, student: users.student.id }, { $unset: { assignedBy: 1 } });
      assert.equal((await call(`/assessment-attempts/${active.id}`, users.student)).status, 403); assert.equal((await answer(active, 1, 0)).status, 403);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve)); assert.match(mongoose.connection.name, /^lms_feedback_test_/); await mongoose.connection.dropDatabase(); await mongoose.disconnect();
  }
});
