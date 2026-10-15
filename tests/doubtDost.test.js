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
import { DoubtDocument, DoubtKnowledgeBase, DoubtSettings, DoubtTurn, DoubtUsage, doubtModels } from "../models/DoubtDost.js";
import { processDoubtJob } from "../services/doubtWorker.js";
import { groundedAnswer, doubtProvider } from "../services/doubtProvider.js";
import { reserveUsage, monthKey, dayKey } from "../services/doubtUsage.js";

function resultFor(doc, store, text = "RAM is volatile memory. This is a synthetic course explanation.") {
  return { candidates: [{ finishReason: "STOP", content: { parts: [{ text }] }, groundingMetadata: { groundingChunks: [{ retrievedContext: { title: String(doc._id), fileSearchStore: store, customMetadata: [{ key: "document_id", stringValue: String(doc._id) }], pageNumber: 1, text: "Synthetic supporting passage from this course only." } }], groundingSupports: [{ groundingChunkIndices: [0] }] } }], usageMetadata: { promptTokenCount: 350, candidatesTokenCount: 100, thoughtsTokenCount: 10 } };
}
test("grounding rejects unknown or cross-store material, missing evidence, incomplete output and invented page references", () => {
  const doc = { _id: "abc", filename: "course.pdf", pages: 2 }, store = "fileSearchStores/course";
  const result = resultFor(doc, store);
  assert.equal(groundedAnswer(result, [doc], store).status, "answered");
  for (const change of [r => { r.candidates[0].groundingMetadata.groundingChunks[0].retrievedContext.title = "other"; r.candidates[0].groundingMetadata.groundingChunks[0].retrievedContext.customMetadata = []; }, r => { r.candidates[0].groundingMetadata.groundingChunks[0].retrievedContext.fileSearchStore = "fileSearchStores/other"; }, r => { r.candidates[0].groundingMetadata.groundingSupports = []; }, r => { r.candidates[0].finishReason = "MAX_TOKENS"; }]) {
    const bad = structuredClone(result); change(bad); const answer = groundedAnswer(bad, [doc], store); assert.equal(answer.status, "unanswered"); assert.ok(!answer.answer.includes("RAM")); assert.deepEqual(answer.sources, []);
  }
  result.candidates[0].groundingMetadata.groundingChunks[0].retrievedContext.pageNumber = 999;
  assert.equal(groundedAnswer(result, [doc], store).sources[0].page, undefined);
  const image = resultFor(doc, store);
  delete image.candidates[0].groundingMetadata.groundingChunks[0].retrievedContext.text;
  image.candidates[0].groundingMetadata.groundingChunks[0].retrievedContext.mediaId = `${store}/media/scanned-page`;
  assert.equal(groundedAnswer(image, [doc], store).status, "answered");
  assert.match(groundedAnswer(image, [doc], store).sources[0].excerpt, /image in the PDF/);
  assert.match(groundedAnswer({}, [doc], store, "en").answer, /could not establish/);
});

test("Gemini REST upload, operation polling, document lookup and idempotent cleanup use the documented resources", async () => {
  const original = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = "synthetic-key";
  const calls = [], store = "fileSearchStores/test-store", doc = { _id: "document-id" }, name = `${store}/documents/document-id`;
  const fetcher = async (url, options) => {
    url = String(url); calls.push({ url, options });
    assert.equal(options.headers["x-goog-api-key"], "synthetic-key");
    assert.equal(new URL(url).searchParams.has("key"), false);
    if (options.method === "DELETE") return new Response(null, { status: 404 });
    if (url.endsWith("/v1beta/fileSearchStores")) { assert.equal(JSON.parse(options.body).embeddingModel, "models/gemini-embedding-2"); return Response.json({ name: store }); }
    if (url.includes("upload_id=")) { assert.equal(options.body.toString(), "synthetic-pdf"); assert.equal(options.headers["X-Goog-Upload-Command"], "upload, finalize"); return Response.json({ name: `${store}/upload/operations/op`, done: false }); }
    if (url.includes(":uploadToFileSearchStore")) { const body = JSON.parse(options.body); assert.equal(body.customMetadata[0].stringValue, doc._id); assert.equal(body.chunkingConfig.whiteSpaceConfig.maxTokensPerChunk, 400); return new Response(null, { headers: { "x-goog-upload-url": `https://generativelanguage.googleapis.com/upload/v1beta/${store}:uploadToFileSearchStore?upload_id=fixture` } }); }
    if (url.includes("/upload/operations/")) return Response.json({ done: true, response: { documentName: name } });
    if (url.endsWith("/documents/document-id")) return Response.json({ name, displayName: doc._id, state: "ACTIVE" });
    if (url.includes("/documents?")) return Response.json({ documents: [{ name, displayName: doc._id, state: "ACTIVE" }] });
    throw new Error("Unexpected provider request");
  };
  try {
    const p = doubtProvider(fetcher);
    assert.equal(await p.createStore("course"), store);
    const operation = await p.upload(store, doc, Buffer.from("synthetic-pdf"));
    assert.equal((await p.operation(operation.name)).response.documentName, name);
    assert.equal((await p.document(name)).state, "ACTIVE");
    assert.equal((await p.findDocument(store, doc._id)).name, name);
    await p.removeDocument(name); await p.removeStore(store);
    assert.ok(calls.every(call => call.options.redirect === "error"));
  } finally { if (original === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = original; }
});

test("Gemini adapter pins its origin, checks upload destinations, constrains retrieval and hides provider secrets", async () => {
  const original = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = "fixture-never-send";
  const calls = [], fetcher = async (url, options) => { calls.push({ url: String(url), ...options }); if (String(url).includes("uploadToFileSearchStore")) return new Response("", { headers: { "x-goog-upload-url": "https://evil.invalid/steal" } }); if (String(url).includes(":generateContent")) return Response.json({ candidates: [] }); return Response.json({ error: { message: "SECRET fixture-never-send" } }, { status: 401 }); };
  try {
    const provider = doubtProvider(fetcher), doc = { _id: "abc" };
    await assert.rejects(provider.upload("fileSearchStores/course", doc, Buffer.from("pdf")), /valid PDF upload/);
    assert.equal(calls.length, 1);
    await assert.rejects(provider.operation("https://evil.invalid"), /invalid resource/);
    await provider.answer({ store: "fileSearchStores/course", documents: [doc], question: "Question", language: "hi", history: [] });
    const body = JSON.parse(calls.at(-1).body);
    assert.deepEqual(body.tools[0].fileSearch.fileSearchStoreNames, ["fileSearchStores/course"]);
    assert.equal(body.tools[0].fileSearch.metadataFilter, 'document_id = "abc"');
    assert.equal(body.tools[0].fileSearch.topK, 6); assert.equal(body.generationConfig.maxOutputTokens, 1200);
    assert.ok(body.systemInstruction.parts[0].text.includes("Hindi (Devanagari)"));
    await assert.rejects(provider.createStore("course"), e => !e.message.includes("SECRET") && !e.message.includes("fixture-never-send"));
  } finally { if (original === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = original; }
});

test("Doubt Dost private knowledge base, grounded answers, budgets, revocation and cleanup (MongoDB + HTTP; providers mocked)", { timeout: 120000 }, async t => {
  await mongoose.connect(`mongodb://127.0.0.1:${process.env.TEST_MONGO_PORT || 27018}/lms_doubt_${crypto.randomBytes(6).toString("hex")}`);
  await Promise.all([User, Session, Course, Category, Enrollment, AuditEvent, ...doubtModels].map(model => model.init()));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`, objects = new Map(), remotes = new Map(), operations = new Map();
  let calls = 0, failAnswer = false, failRemove = false, answerGate, entered;
  const storage = {
    upload: async (doc, bytes) => objects.set(doc.objectKey, bytes), read: async doc => objects.get(doc.objectKey),
    remove: async doc => { if (failRemove) throw new Error("Storage failure"); objects.delete(doc.objectKey); },
    link: async doc => ({ url: `https://fixture.invalid/${doc._id}`, expiresAt: Date.now() + 300000 }),
  };
  const provider = {
    createStore: async course => `fileSearchStores/${course}`,
    findDocument: async (store, id) => [...remotes.values()].find(doc => doc.name.startsWith(store + "/") && doc.displayName === String(id)),
    upload: async (store, doc) => { const remote = { name: `${store}/documents/${doc._id}`, displayName: String(doc._id), state: "ACTIVE" }; remotes.set(remote.name, remote); const operation = `${store}/upload/operations/${doc._id}`; operations.set(operation, remote); return { name: operation, done: false }; },
    operation: async name => ({ done: true, response: { documentName: operations.get(name).name } }),
    document: async name => remotes.get(name), removeDocument: async name => remotes.delete(name), removeStore: async name => { for (const [key] of remotes) if (key.startsWith(name + "/")) remotes.delete(key); },
    answer: async args => { calls++; if (entered) entered(); if (answerGate) await answerGate; if (failAnswer) throw new Error("Provider failed with SECRET"); return args.question.includes("unknown") ? { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "SECRET UNSUPPORTED ANSWER" }] } }] } : resultFor(args.documents[0], args.store); },
  };
  app.locals.doubtStorage = storage; app.locals.doubtProvider = provider;
  const request = async (path, cookie, method = "GET", body) => { const form = body instanceof FormData; const response = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(!form ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: form ? body : JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] }; };
  const pdf = async text => { const doc = await PDFDocument.create(); doc.addPage().drawText(text); return Buffer.from(await doc.save()); };
  const users = {}; let course, docId, draftId;
  const upload = async (bytes, cookie, id = crypto.randomUUID()) => { const form = new FormData(); form.append("uploadId", id); form.append("file", new Blob([bytes], { type: "application/pdf" }), "computer-notes.pdf"); return request(`/admin/doubt-dost/courses/${course}/documents`, cookie, "POST", form); };
  const work = async () => { await DoubtDocument.updateMany({}, { nextAttemptAt: null, leaseUntil: null }); return processDoubtJob({ provider, storage, configured: true }); };
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
      assert.equal((await request(`/courses/${course}/doubt-dost`, users.student.cookie)).body.data.available, false);
      const preview = await request(`/admin/doubt-dost/courses/${course}/preview`, users.admin.cookie, "POST", { question: "RAM?", language: "hi", requestId: crypto.randomUUID() });
      assert.equal(preview.status, 201); assert.equal(preview.body.data.turn.status, "answered");
      assert.equal((await request(`/admin/doubt-dost/courses/${course}/documents/${docId}`, users.admin.cookie, "PUT", { action: "publish" })).status, 200);
      const draft = await upload(await pdf("Draft source: not visible to students"), users.admin.cookie); draftId = draft.body.data.document.id; await work(); await work();
    });
    await t.test("course access includes waived students, denies unpaid/unassigned users and isolates PDF links", async () => {
      assert.equal((await ask("RAM?", users.stranger.cookie)).status, 403);
      assert.equal((await ask("RAM?", users.unpaid.cookie)).status, 402);
      assert.equal((await request(`/courses/${course}/doubt-dost`, users.instructor.cookie)).status, 403);
      assert.equal((await request(`/courses/${course}/doubt-dost/documents/${draftId}/url`, users.student.cookie)).status, 404);
      assert.equal((await request(`/courses/${course}/doubt-dost/documents/${docId}/url`, users.student.cookie)).status, 200);
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
      assert.equal(objects.size, 0); assert.equal(remotes.size, 0);
    });
  } finally { delete app.locals.doubtStorage; delete app.locals.doubtProvider; await new Promise(resolve => server.close(resolve)); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
});
