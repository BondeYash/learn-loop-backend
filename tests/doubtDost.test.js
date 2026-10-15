import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { PDFDocument } from "pdf-lib";
import app from "../app.js";
import User from "../models/User.js";
import Session from "../models/Session.js";
import Course from "../models/Course.js";
import Category from "../models/Category.js";
import Enrollment from "../models/Enrollment.js";
import AuditEvent from "../models/AuditEvent.js";
import { DoubtChunk, DoubtDocument, DoubtKnowledgeBase, DoubtSettings, DoubtTurn, DoubtUsage, doubtModels } from "../models/DoubtDost.js";
import { processDoubtJob } from "../services/doubtWorker.js";
import { groundedAnswer, doubtProvider } from "../services/doubtProvider.js";
import { reserveUsage, monthKey, dayKey } from "../services/doubtUsage.js";

function resultFor(doc, passages, text = "RAM is volatile memory. This is a synthetic course explanation.") {
  return { complete: true, supported: true, answer: text, citations: [{ id: passages[0].id, quote: passages[0].text.slice(0, 80) }], usage: { inputTokens: 350, outputTokens: 110 } };
}
test("grounding rejects invented citations, invalid pages, unsupported answers and withdrawn documents", () => {
  const doc = { _id: "abc", filename: "course.pdf", pages: 2 };
  const passages = [{ id: "S1", document: "abc", page: 1, text: "RAM is volatile memory used for temporary work." }];
  const result = resultFor(doc, passages);
  assert.equal(groundedAnswer(result, [doc], passages).status, "answered");
  for (const change of [r => { r.citations[0].id = "invented"; }, r => { r.citations[0].quote = "A fabricated quotation"; }, r => { r.complete = false; }, r => { r.supported = false; }, r => { r.citations = []; }]) {
    const bad = structuredClone(result); change(bad);
    assert.equal(groundedAnswer(bad, [doc], passages).status, "unanswered");
  }
  assert.equal(groundedAnswer(result, [], passages).status, "unanswered");
  assert.equal(groundedAnswer(result, [doc], [{ ...passages[0], page: 99 }]).status, "unanswered");
  assert.match(groundedAnswer({}, [doc], passages, "en").answer, /could not establish/);
});
test("Groq adapter pins its origin, constrains prompts, handles quotas and never echoes secrets", async () => {
  const original = process.env.GROQ_API_KEY; process.env.GROQ_API_KEY = "fixture-never-send";
  const calls = [];
  const fetcher = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, options, body });
    assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer fixture-never-send");
    assert.equal(options.redirect, "error");
    assert.equal(body.model, "openai/gpt-oss-20b");
    assert.equal(body.reasoning_effort, "low"); assert.equal(body.include_reasoning, false);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ supported: true, answer: "RAM stores temporary information.", citations: [{ id: "S1", quote: "RAM is temporary memory." }], keywords: "memory मेमोरी RAM" }) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
  };
  try {
    const p = doubtProvider(fetcher), passages = [{ id: "S1", text: "RAM is temporary memory." }];
    const answer = await p.answer({ question: "RAM?", language: "hi", history: [], passages });
    assert.equal(answer.complete, true); assert.equal(answer.usage.inputTokens, 100);
    assert.match(calls[0].body.messages[0].content, /Hindi/); assert.equal(calls[0].body.max_completion_tokens, 1536);
    assert.equal(calls[0].body.tools, undefined, "no external search or paid tools");
    const rewrite = await p.rewrite({ question: "मेमोरी क्या है", history: [] });
    assert.match(rewrite.query, /memory/);
    await assert.rejects(doubtProvider(async () => Response.json({ error: "SECRET fixture-never-send" }, { status: 429 })).answer({ question: "RAM?", language: "en", history: [], passages }), e => e.providerStatus === 429 && /free request or token limit/.test(e.message) && !e.message.includes("SECRET") && !e.message.includes("fixture-never-send"));
  } finally { if (original === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = original; }
});

test("Doubt Dost private knowledge base, grounded answers, budgets, revocation and cleanup (MongoDB + HTTP; providers mocked)", { timeout: 120000 }, async t => {
  await mongoose.connect(`mongodb://127.0.0.1:${process.env.TEST_MONGO_PORT || 27018}/lms_doubt_${crypto.randomBytes(6).toString("hex")}`);
  await Promise.all([User, Session, Course, Category, Enrollment, AuditEvent, ...doubtModels].map(model => model.init()));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`, objects = new Map();
  let calls = 0, failAnswer = false, failRemove = false, answerGate, entered;
  const storage = {
    upload: async (doc, bytes) => objects.set(doc.objectKey, bytes), read: async doc => objects.get(doc.objectKey),
    remove: async doc => { if (failRemove) throw new Error("Storage failure"); objects.delete(doc.objectKey); },
    link: async doc => ({ url: `https://fixture.invalid/${doc._id}`, expiresAt: Date.now() + 300000 }),
  };
  const provider = {
    rewrite: async () => ({ query: "RAM", usage: { inputTokens: 0, outputTokens: 0 } }),
    answer: async args => { calls++; assert.ok(args.passages.every(passage => !passage.text.includes("PRIVATE_OTHER_COURSE"))); if (entered) entered(); if (answerGate) await answerGate; if (failAnswer) throw new Error("Provider failed with SECRET"); return args.question.includes("unknown") ? { complete: true, supported: false, answer: "SECRET UNSUPPORTED ANSWER", citations: [], usage: {} } : resultFor(args.documents[0], args.passages); },
  };
  app.locals.doubtStorage = storage; app.locals.doubtProvider = provider;
  const request = async (path, cookie, method = "GET", body) => { const form = body instanceof FormData; const response = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(!form ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: form ? body : JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] }; };
  const pdf = async text => { const doc = await PDFDocument.create(); doc.addPage().drawText(text); return Buffer.from(await doc.save()); };
  const users = {}; let course, docId, draftId;
  const upload = async (bytes, cookie, id = crypto.randomUUID()) => { const form = new FormData(); form.append("uploadId", id); form.append("file", new Blob([bytes], { type: "application/pdf" }), "computer-notes.pdf"); return request(`/admin/doubt-dost/courses/${course}/documents`, cookie, "POST", form); };
  const work = async () => { await DoubtDocument.updateMany({}, { nextAttemptAt: null, leaseUntil: null }); return processDoubtJob({ storage }); };
  const ask = (question, cookie = users.student.cookie, id = crypto.randomUUID()) => request(`/courses/${course}/doubt-dost`, cookie, "POST", { question, language: "hinglish", requestId: id });
  try {
    for (const role of ["admin", "instructor", "student", "stranger", "unpaid"]) { const password = crypto.randomBytes(16).toString("hex"), user = await User.create({ name: role, role: ["stranger", "unpaid"].includes(role) ? "student" : role, email: `${role}@example.invalid`, password }); users[role] = { id: user._id, password, cookie: (await request("/auth/login", null, "POST", { email: user.email, password })).cookie }; }
    const category = await Category.create({ name: "Doubt fixture" });
    course = String((await Course.create({ title: "Computers", description: "Fixture", category: category._id, instructor: users.instructor.id, isPublished: true, price: 199 }))._id);
    await Enrollment.create({ course, student: users.student.id, assignedBy: users.instructor.id, paymentWaivedAt: new Date(), paymentWaivedBy: users.instructor.id });
    await Enrollment.create({ course, student: users.unpaid.id, assignedBy: users.instructor.id });
    const bytes = await pdf("RAM volatile memory - synthetic course material");
    await t.test("admin-only PDF intake, validation, idempotency and draft indexing", async () => {
      assert.equal((await upload(bytes)).status, 401);
      for (const role of ["instructor", "student"]) assert.equal((await upload(bytes, users[role].cookie)).status, 403);
      assert.equal((await upload(Buffer.from("%PDF-1.7 fake %%EOF"), users.admin.cookie)).status, 422);
      const id = crypto.randomUUID(), created = await upload(bytes, users.admin.cookie, id); assert.equal(created.status, 201); docId = created.body.data.document.id;
      assert.equal(created.body.data.document.published, false); assert.equal(created.body.data.document.objectKey, undefined);
      assert.equal((await upload(bytes, users.admin.cookie, id)).body.data.document.id, docId);
      assert.equal((await upload(bytes, users.admin.cookie)).body.data.document.id, docId);
      assert.equal(objects.size, 1);
      await work(); await work();
      assert.equal((await DoubtDocument.findById(docId)).status, "ready");
      const waiting = (await request(`/courses/${course}/doubt-dost`, users.student.cookie)).body.data;
      assert.equal(waiting.available, false); assert.equal(waiting.readiness.code, "awaiting_publication");
      assert.ok(!JSON.stringify(waiting).includes("computer-notes.pdf"), "draft source details stay private");
      const preview = await request(`/admin/doubt-dost/courses/${course}/preview`, users.admin.cookie, "POST", { question: "RAM?", language: "hi", requestId: crypto.randomUUID() });
      assert.equal(preview.status, 201); assert.equal(preview.body.data.turn.status, "answered");
      assert.equal((await request(`/admin/doubt-dost/courses/${course}/documents/${docId}`, users.admin.cookie, "PUT", { action: "publish" })).status, 200);
      const draft = await upload(await pdf("Draft source: not visible to students"), users.admin.cookie); draftId = draft.body.data.document.id; await work(); await work();
    });
    await t.test("publication survives repeated reads, duplicate uploads, worker cycles and service pauses", async () => {
      const publishedAt = (await DoubtDocument.findById(docId)).publishedAt.getTime();
      for (let i = 0; i < 2; i++) {
        await work();
        const history = await request(`/courses/${course}/doubt-dost`, users.student.cookie);
        assert.equal(history.body.data.available, true); assert.equal(history.body.data.readiness.code, "ready");
        const library = await request(`/admin/doubt-dost/courses/${course}/documents`, users.admin.cookie);
        assert.equal(library.body.data.documents.find(doc => doc.id === docId).published, true);
      }
      assert.equal((await upload(bytes, users.admin.cookie)).body.data.document.published, true);
      const chunksBefore = await DoubtChunk.countDocuments({ document: docId });
      await DoubtDocument.updateOne({ _id: docId }, { $unset: { searchVersion: 1 } });
      assert.equal((await request(`/courses/${course}/doubt-dost`, users.student.cookie)).body.data.readiness.code, "indexing");
      await work();
      assert.equal((await DoubtDocument.findById(docId)).published, true, "legacy migration preserves publication");
      assert.equal(await DoubtChunk.countDocuments({ document: docId }), chunksBefore);
      await DoubtSettings.findOneAndUpdate({ _id: "global" }, { enabled: false }, { upsert: true });
      assert.equal((await request(`/courses/${course}/doubt-dost`, users.student.cookie)).body.data.readiness.code, "paused");
      assert.equal((await DoubtDocument.findById(docId)).published, true);
      await DoubtSettings.updateOne({ _id: "global" }, { enabled: true });
      assert.equal((await request(`/courses/${course}/doubt-dost`, users.student.cookie)).body.data.available, true);
      assert.equal((await DoubtDocument.findById(docId)).publishedAt.getTime(), publishedAt);
      assert.equal(calls, 1, "readiness checks never generate an AI answer");
    });
    await t.test("course access includes waived students, denies unpaid/unassigned users and isolates PDF links", async () => {
      assert.equal((await ask("RAM?", users.stranger.cookie)).status, 403);
      assert.equal((await ask("RAM?", users.unpaid.cookie)).status, 402);
      assert.equal((await request(`/courses/${course}/doubt-dost`, users.instructor.cookie)).status, 403);
      assert.equal((await request(`/courses/${course}/doubt-dost/documents/${draftId}/url`, users.student.cookie)).status, 404);
      assert.equal((await request(`/courses/${course}/doubt-dost/documents/${docId}/url`, users.student.cookie)).status, 200);
      await DoubtChunk.create({ course: new mongoose.Types.ObjectId(), document: docId, position: 999, page: 1, text: "PRIVATE_OTHER_COURSE RAM memory", terms: ["ram", "memory"], version: 1 });
      const id = crypto.randomUUID(), before = calls, answer = await ask("Explain RAM", users.student.cookie, id);
      assert.equal(answer.status, 201); assert.equal(answer.body.data.turn.status, "answered"); assert.equal(answer.body.data.turn.sources[0].page, 1);
      assert.equal((await ask("Explain RAM", users.student.cookie, id)).body.data.turn.id, answer.body.data.turn.id); assert.equal(calls, before + 1);
      assert.equal((await ask("Another question", users.student.cookie, id)).status, 409);
      const history = await request(`/courses/${course}/doubt-dost`, users.student.cookie);
      assert.equal(history.body.data.turns.length, 1); assert.ok(!JSON.stringify(history.body).includes("fileSearchStores")); assert.ok(!JSON.stringify(history.body).includes("objectKey"));
      assert.equal((await request(`/courses/${course}/doubt-dost/${answer.body.data.turn.id}/feedback`, users.student.cookie, "PUT", { feedback: "unhelpful" })).status, 200);
      assert.equal((await request(`/courses/${course}/doubt-dost/${answer.body.data.turn.id}/feedback`, users.stranger.cookie, "PUT", { feedback: "helpful" })).status, 403);
      await Enrollment.create({ course, student: users.stranger.id, assignedBy: users.instructor.id, paymentWaivedAt: new Date(), paymentWaivedBy: users.instructor.id });
      assert.deepEqual((await request(`/courses/${course}/doubt-dost`, users.stranger.cookie)).body.data.turns, []);
      assert.equal((await request(`/courses/${course}/doubt-dost/${answer.body.data.turn.id}/feedback`, users.stranger.cookie, "PUT", { feedback: "helpful" })).status, 404);
      await Enrollment.deleteOne({ course, student: users.stranger.id });
      assert.equal((await ask("unknown fact")).body.data.turn.status, "unanswered");
      assert.ok(!JSON.stringify((await request(`/courses/${course}/doubt-dost`, users.student.cookie)).body).includes("UNSUPPORTED ANSWER"));
    });
    await t.test("unpublishing while generation is in progress suppresses its answer and old source text", async () => {
      let release; answerGate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
      const pending = ask("A question during unpublish"); await started;
      await request(`/admin/doubt-dost/courses/${course}/documents/${docId}`, users.admin.cookie, "PUT", { action: "unpublish" });
      release(); const result = await pending; answerGate = null; entered = null;
      assert.equal(result.body.data.turn.status, "unanswered"); assert.ok(!result.body.data.turn.answer.includes("RAM"));
      const history = (await request(`/courses/${course}/doubt-dost`, users.student.cookie)).body.data.turns;
      assert.ok(history.every(turn => !turn.answer.includes("RAM")));
      await request(`/admin/doubt-dost/courses/${course}/documents/${docId}`, users.admin.cookie, "PUT", { action: "publish" });
    });
    await t.test("revocation during a provider call denies the response and concurrent asks do not double-charge", async () => {
      let release; answerGate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
      const before = calls, pending = ask("Wait for this answer"); await started;
      assert.equal((await ask("Concurrent second question")).status, 409); assert.equal(calls, before + 1);
      await Enrollment.deleteOne({ course, student: users.student.id }); release();
      assert.equal((await pending).status, 403); answerGate = null; entered = null;
      await Enrollment.create({ course, student: users.student.id, assignedBy: users.instructor.id, paymentWaivedAt: new Date(), paymentWaivedBy: users.instructor.id });
    });
    await t.test("persistent daily/monthly budgets and disabled mode stop provider calls", async () => {
      await DoubtUsage.updateOne({ _id: dayKey(users.student.id) }, { answers: 0 });
      await DoubtSettings.findOneAndUpdate({ _id: "global" }, { dailyAnswers: 1 }, { upsert: true });
      assert.equal((await ask("One budgeted question")).status, 201); const before = calls;
      assert.equal((await ask("Past daily budget")).status, 429); assert.equal(calls, before);
      await DoubtSettings.updateOne({ _id: "global" }, { dailyAnswers: 20, enabled: false });
      assert.equal((await ask("Disabled question")).status, 503); assert.equal(calls, before);
      await DoubtSettings.updateOne({ _id: "global" }, { enabled: true });
      const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => reserveUsage("month:concurrent-fixture", "answers", 1, 3)));
      assert.equal(attempts.filter(item => item.status === "fulfilled").length, 3);
      assert.equal((await DoubtUsage.findById("month:concurrent-fixture")).answers, 3);
      assert.ok((await DoubtUsage.findById(monthKey())).answers > 0);
    });
    await t.test("provider failures retain a safe question record; source removal remains hidden and retries", async () => {
      failAnswer = true; assert.equal((await ask("Provider interruption")).status, 500); failAnswer = false;
      const history = await request(`/courses/${course}/doubt-dost`, users.student.cookie); assert.ok(!JSON.stringify(history.body).includes("SECRET"));
      const bytesBefore = (await DoubtUsage.findById("storage")).bytes;
      await request(`/admin/doubt-dost/courses/${course}/documents/${docId}`, users.admin.cookie, "DELETE");
      assert.equal((await request(`/courses/${course}/doubt-dost/documents/${docId}/url`, users.student.cookie)).status, 404);
      failRemove = true; await work(); assert.equal((await DoubtDocument.findById(docId)).status, "removing"); failRemove = false;
      await work(); assert.equal(await DoubtDocument.findById(docId), null);
      assert.ok((await DoubtUsage.findById("storage")).bytes < bytesBefore);
      const activity = await request("/admin/doubt-dost/activity?needsHelp=true", users.admin.cookie); assert.equal(activity.status, 200); assert.ok(activity.body.data.total > 0);
      assert.equal((await request("/admin/doubt-dost", users.student.cookie)).status, 403);
    });
    await t.test("course purge preserves removal work and removes chat history", async () => {
      assert.equal((await request(`/admin/courses/${course}`, users.admin.cookie, "DELETE")).status, 200);
      assert.equal(await DoubtTurn.countDocuments({ course }), 0);
      assert.equal((await DoubtKnowledgeBase.findOne({ course })).removing, true);
      await work(); await work();
      assert.equal(await DoubtDocument.countDocuments({ course }), 0); assert.equal(await DoubtKnowledgeBase.countDocuments({ course }), 0);
      assert.equal(await DoubtChunk.countDocuments({ course }), 0);
      assert.equal(objects.size, 0);
    });
  } finally { delete app.locals.doubtStorage; delete app.locals.doubtProvider; await new Promise(resolve => server.close(resolve)); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
});
