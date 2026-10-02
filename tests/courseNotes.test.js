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
import Module from "../models/Module.js";
import Lesson from "../models/Lesson.js";
import CourseNote from "../models/CourseNote.js";
import AuditEvent from "../models/AuditEvent.js";
import Enrollment from "../models/Enrollment.js";
import { validatePdf, safePdfName, MAX_PDF_BYTES } from "../services/pdfValidation.js";
import { courseNoteStore } from "../services/courseNoteStore.js";

const makePdf = async () => { const pdf = await PDFDocument.create(); pdf.addPage().drawText("Private course notes fixture"); return Buffer.from(await pdf.save()); };
test("PDF validation checks structure and rejects active content, corruption and oversize bytes", async () => {
  const bytes = await makePdf(); assert.equal(await validatePdf(bytes), 1);
  for (const invalid of [Buffer.from("not a PDF"), Buffer.from("%PDF-1.7\nnot a document\n%%EOF"), bytes.subarray(0, -20), Buffer.alloc(MAX_PDF_BYTES + 1)]) await assert.rejects(validatePdf(invalid), /valid, unencrypted PDF/);
  const active = await PDFDocument.load(bytes); active.addJavaScript("script", "app.alert('fixture')");
  await assert.rejects(validatePdf(Buffer.from(await active.save())), /valid, unencrypted PDF/);
  assert.equal(safePdfName('../../private"\r\n.pdf'), "private___.pdf");
});
test("PDF object storage verifies completion and signs safe inline/download responses", async () => {
  const commands = []; const note = { storageBucket: "fixture", objectKey: "notes/fixture/id.pdf", filename: "safe.pdf", sha256: "abc" };
  const store = courseNoteStore({ send: async (command) => { commands.push(command); return { ContentLength: 5, ContentType: "application/pdf", Metadata: { sha256: "abc" } }; } }, async (_, command, options) => { commands.push(command); assert.equal(options.expiresIn, 300); return "https://fixture.invalid/signed"; });
  await store.upload(note, Buffer.from("bytes"));
  assert.equal(commands[0].input.ContentLength, 5);
  await store.link(note, true); assert.equal(commands.at(-1).input.ResponseContentDisposition, 'attachment; filename="safe.pdf"');
  await store.link(note, false); assert.equal(commands.at(-1).input.ResponseContentDisposition, 'inline; filename="safe.pdf"');
  const broken = courseNoteStore({ send: async () => ({ ContentLength: 1 }) });
  await assert.rejects(broken.upload(note, Buffer.from("bytes")), /verification failed/);
});
test("private course PDF workflow and assignment sharing (isolated MongoDB + HTTP; R2 mocked)", { timeout: 120000 }, async (t) => {
  process.env.NODE_ENV = "test";
  await mongoose.connect(`mongodb://127.0.0.1:${process.env.TEST_MONGO_PORT || 27018}/lms_test_${crypto.randomBytes(6).toString("hex")}`, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([User, Session, Course, Category, Module, Lesson, CourseNote, AuditEvent, Enrollment].map((model) => model.init()));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const objects = new Map(); let failUpload = false; let failRemoval = false;
  app.locals.courseNoteStore = {
    upload: async (note, bytes) => { if (failUpload) throw new Error("Fixture storage unavailable"); objects.set(note.objectKey, bytes); },
    link: async (note, download) => ({ url: `https://fixture.invalid/${download ? "download" : "open"}/${note._id}`, expiresAt: Date.now() + 300000 }),
    remove: async (note) => { if (failRemoval) throw new Error("Fixture storage unavailable"); objects.delete(note.objectKey); },
  };
  const request = async (path, cookie, method = "GET", body) => {
    const form = body instanceof FormData;
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(!form ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: form ? body : JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const bytes = await makePdf();
  const upload = (course, cookie, { file = bytes, filename = "handout.pdf", type = "application/pdf", uploadId = crypto.randomUUID() } = {}) => {
    const form = new FormData(); form.append("uploadId", uploadId); form.append("file", new Blob([file], { type }), filename);
    return request(`/courses/${course}/notes`, cookie, "POST", form);
  };
  try {
    const users = {};
    for (const role of ["owner", "other", "admin", "student", "stranger"]) {
      const password = crypto.randomBytes(20).toString("hex"); const user = await User.create({ name: role, role: ["owner", "other"].includes(role) ? "instructor" : role === "stranger" ? "student" : role, email: `${role}@example.invalid`, password });
      users[role] = { id: user._id, cookie: (await request("/auth/login", null, "POST", { email: user.email, password })).cookie };
    }
    const category = await Category.create({ name: "General" });
    const created = await request("/courses", users.owner.cookie, "POST", { title: "Notes course", description: "Fixture", category: category._id, setupLessons: true });
    assert.equal(created.status, 201); const course = created.body.data.course._id;
    assert.equal(await Module.countDocuments({ course }), 1); assert.equal(created.body.data.course.isPublished, false);
    const endpoint = `/courses/${course}/notes`; let first;
    await t.test("only owner/admin can upload; filenames/MIME alone cannot pass", async () => {
      assert.equal((await upload(course)).status, 401);
      for (const role of ["other", "student", "stranger"]) assert.equal((await upload(course, users[role].cookie)).status, 403);
      assert.equal((await upload(course, users.owner.cookie, { file: Buffer.from("%PDF-1.7 fake %%EOF") })).status, 422);
      assert.equal((await upload(course, users.owner.cookie, { type: "text/html" })).status, 400);
      assert.equal((await upload(course, users.owner.cookie, { filename: "handout.html" })).status, 400);
      assert.equal((await upload(course, users.owner.cookie, { file: Buffer.alloc(MAX_PDF_BYTES + 1) })).status, 413);
      const id = crypto.randomUUID();
      const made = await upload(course, users.owner.cookie, { uploadId: id, filename: 'notes".pdf' });
      assert.equal(made.status, 201); first = made.body.data.note;
      assert.equal(first.filename, "notes_.pdf"); assert.equal(first.objectKey, undefined); assert.equal(first.storageBucket, undefined);
      assert.equal((await upload(course, users.owner.cookie, { uploadId: id })).body.data.note.id, first.id);
      assert.equal((await upload(course, users.admin.cookie)).status, 201);
    });
    await t.test("assignment opens ready course without publication step; students only receive assigned ready notes", async () => {
      assert.equal((await request(endpoint, users.student.cookie)).status, 403);
      const shared = await request(`/courses/${course}/assignments`, users.owner.cookie, "POST", { emails: ["student@example.invalid"], makeAvailable: true });
      assert.equal(shared.status, 200); assert.equal((await Course.findById(course)).isPublished, true);
      assert.equal((await request(endpoint, users.student.cookie)).body.data.notes.length, 2);
      for (const role of ["other", "stranger"]) {
        assert.equal((await request(endpoint, users[role].cookie)).status, 403);
        assert.equal((await request(`${endpoint}/${first.id}/url`, users[role].cookie)).status, 403);
      }
      assert.equal((await request(`${endpoint}/${first.id}/url?download=true`, users.student.cookie)).status, 200);
      for (const role of ["student", "stranger", "other"]) assert.equal((await request(`${endpoint}/${first.id}`, users[role].cookie, "DELETE")).status, 403);
      const module = await Module.findOne({ course });
      const pending = await Lesson.create({ course, module: module._id, title: "Unfinished video", contentType: "video", order: 0 });
      assert.equal((await request(`/courses/${course}/assignments`, users.owner.cookie, "POST", { emails: ["stranger@example.invalid"], makeAvailable: true })).status, 409);
      assert.equal(await Enrollment.countDocuments({ course, student: users.stranger.id }), 0);
      assert.equal((await request(`/courses/${course}`, users.student.cookie)).body.data.modules[0].lessons.length, 0);
      await pending.deleteOne();
    });
    await t.test("failed uploads stay private and retry idempotently; removal failure stays hidden", async () => {
      const id = crypto.randomUUID(); failUpload = true;
      assert.equal((await upload(course, users.owner.cookie, { uploadId: id })).status, 503);
      assert.equal((await request(endpoint, users.student.cookie)).body.data.notes.length, 2);
      const failed = await CourseNote.findOne({ course, uploadId: id });
      assert.equal((await request(`${endpoint}/${failed._id}/url`, users.student.cookie)).status, 404);
      failUpload = false;
      const retry = await upload(course, users.owner.cookie, { uploadId: id }); assert.equal(retry.status, 201); assert.equal(retry.body.data.note.id, String(failed._id));
      failRemoval = true;
      assert.equal((await request(`${endpoint}/${failed._id}`, users.owner.cookie, "DELETE")).status, 503);
      assert.equal((await request(`${endpoint}/${failed._id}/url`, users.student.cookie)).status, 404);
      failRemoval = false; assert.equal((await request(`${endpoint}/${failed._id}`, users.admin.cookie, "DELETE")).status, 200);
      assert.equal(await CourseNote.countDocuments({ _id: failed._id }), 0);
    });
    await t.test("archive retains PDFs, revocation denies links, and course ID cannot be substituted", async () => {
      const otherCourse = await Course.create({ title: "Other course", description: "Fixture", category: category._id, instructor: users.other.id });
      assert.equal((await request(`/courses/${otherCourse._id}/notes/${first.id}/url`, users.other.cookie)).status, 404);
      await request(`/courses/${course}`, users.owner.cookie, "DELETE");
      assert.equal((await request(`${endpoint}/${first.id}/url`, users.student.cookie)).status, 410);
      assert.equal(await CourseNote.countDocuments({ course }), 2); assert.equal(objects.size, 2);
      await request(`/courses/${course}/restore`, users.owner.cookie, "POST", {});
      assert.equal((await request(endpoint, users.student.cookie)).status, 403);
      await request(`/courses/${course}/assignments`, users.owner.cookie, "POST", { emails: ["student@example.invalid"], makeAvailable: true });
      assert.equal((await request(endpoint, users.student.cookie)).status, 200);
      await request(`/courses/${course}/assignments/${users.student.id}`, users.owner.cookie, "DELETE");
      assert.equal((await request(`${endpoint}/${first.id}/url`, users.student.cookie)).status, 403);
    });
    await t.test("unique slots enforce twenty-note course limit and removal frees capacity", async () => {
      for (let slot = 2; slot < 20; slot++) await CourseNote.create({ course, owner: users.owner.id, slot, uploadId: crypto.randomUUID(), filename: "fixture.pdf", size: 10, sha256: "fixture", status: "ready" });
      assert.equal((await upload(course, users.owner.cookie)).status, 409);
      assert.equal(await CourseNote.countDocuments({ course }), 20);
      await assert.rejects(CourseNote.create({ course, owner: users.owner.id, slot: 0, uploadId: crypto.randomUUID(), filename: "fixture.pdf", size: 10, sha256: "fixture" }), { code: 11000 });
      assert.equal((await request(`${endpoint}/${first.id}`, users.owner.cookie, "DELETE")).status, 200);
      assert.equal((await upload(course, users.owner.cookie)).status, 201);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve)); assert.match(mongoose.connection.name, /^lms_test_/); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); delete app.locals.courseNoteStore;
  }
});
