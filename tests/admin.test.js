import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import mongoose from "mongoose";
import app from "../app.js";
import User from "../models/User.js";
import Session from "../models/Session.js";
import AuditEvent from "../models/AuditEvent.js";
import Category from "../models/Category.js";
import Course from "../models/Course.js";
import Module from "../models/Module.js";
import Lesson from "../models/Lesson.js";
import VideoAsset from "../models/VideoAsset.js";
import Enrollment from "../models/Enrollment.js";
import { bootstrapAdmin } from "../services/bootstrapAdmin.js";

test("admin provisioning, access and credential lifecycle (isolated MongoDB + HTTP)", { timeout: 120000 }, async (t) => {
  process.env.NODE_ENV = "test";
  const db = `lms_test_${crypto.randomBytes(6).toString("hex")}`;
  await mongoose.connect(`mongodb://127.0.0.1:${process.env.TEST_MONGO_PORT || 27018}/${db}`, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([User, Session, AuditEvent, Category, Course, Module, Lesson, VideoAsset, Enrollment].map((model) => model.init()));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (route, cookie, method = "GET", body, extra = {}) => {
    const response = await fetch(base + route, { method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const password = () => crypto.randomBytes(24).toString("base64url");
  const adminPassword = password(); const temporaryPassword = password();
  let admin, adminCookie, instructor, temporaryCookie, instructorCookie, studentCookie, student;
  try {
    await t.test("first-admin bootstrap is non-overwriting, protected against races and never public", async () => {
      const results = await Promise.allSettled([
        bootstrapAdmin({ name: "Admin", email: "admin@example.invalid", password: adminPassword }),
        bootstrapAdmin({ name: "Other admin", email: "other-admin@example.invalid", password: adminPassword }),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      admin = await User.findOne({ role: "admin" });
      assert.equal(await User.countDocuments({ role: "admin" }), 1);
      await assert.rejects(bootstrapAdmin({ name: "No overwrite", email: admin.email, password: password() }), /already exists/);
      assert.equal((await call("/admin/bootstrap", null, "POST", {})).status, 401);
      const login = await call("/auth/login", null, "POST", { email: admin.email, password: adminPassword });
      assert.equal(login.status, 200); adminCookie = login.cookie;
    });
    await t.test("public registration can only create students; submitted privileged fields are ineffective", async () => {
      for (const role of ["admin", "instructor"]) assert.equal((await call("/auth/register", null, "POST", { name: "Blocked", email: `${role}@example.invalid`, password: password(), role })).status, 400);
      const r = await call("/auth/register", null, "POST", { name: "Student", email: "student@example.invalid", password: password(), status: "suspended", authVersion: 999, mustChangePassword: true });
      assert.equal(r.status, 201); student = r.body.data.user; studentCookie = r.cookie;
      assert.equal(student.role, "student"); assert.equal(student.status, "active"); assert.equal(student.mustChangePassword, false);
    });
    await t.test("admin-only create with field whitelisting, duplicate safety and redacted validation", async () => {
      const payload = { name: "Teacher", email: "teacher@example.invalid", temporaryPassword };
      assert.equal((await call("/admin/instructors", null, "POST", payload)).status, 401);
      assert.equal((await call("/admin/instructors", studentCookie, "POST", payload)).status, 403);
      assert.equal((await call("/admin/instructors", adminCookie, "POST", { ...payload, role: "admin" })).status, 400);
      const invalid = await call("/admin/instructors", adminCookie, "POST", { ...payload, temporaryPassword: "Tiny-secret" });
      assert.equal(invalid.status, 400); assert.equal(JSON.stringify(invalid).includes("Tiny-secret"), false);
      const result = await call("/admin/instructors", adminCookie, "POST", payload); assert.equal(result.status, 201);
      instructor = result.body.data.user; assert.equal(instructor.role, "instructor"); assert.equal(instructor.mustChangePassword, true);
      assert.equal(JSON.stringify(result).includes(temporaryPassword), false);
      const stored = await User.findById(instructor.id).select("+password"); assert.notEqual(stored.password, temporaryPassword); assert.equal(await stored.comparePassword(temporaryPassword), true);
      assert.equal((await call("/admin/instructors", adminCookie, "POST", { ...payload, temporaryPassword: password() })).status, 409);
      assert.equal(await User.countDocuments({ email: payload.email }), 1);
    });
    await t.test("temporary sessions allow account/logout/password change but deny normal APIs", async () => {
      const result = await call("/auth/login", null, "POST", { email: instructor.email, password: temporaryPassword });
      assert.equal(result.status, 200); temporaryCookie = result.cookie;
      assert.equal((await call("/auth/me", temporaryCookie)).body.data.user.mustChangePassword, true);
      for (const path of ["/courses/mine", "/admin/users", "/admin/videos"]) { const denied = await call(path, temporaryCookie); assert.equal(denied.status, 403); assert.equal(denied.body.code, "PASSWORD_CHANGE_REQUIRED"); }
      assert.equal((await call("/auth/change-password", temporaryCookie, "POST", { currentPassword: temporaryPassword, password: temporaryPassword })).status, 400);
      assert.equal((await call("/auth/change-password", temporaryCookie, "POST", { currentPassword: "wrong", password: password() })).status, 400);
      const updated = await call("/auth/change-password", temporaryCookie, "POST", { currentPassword: temporaryPassword, password: password() });
      assert.equal(updated.status, 200); instructorCookie = updated.cookie; assert.equal(updated.body.data.user.mustChangePassword, false);
      assert.equal((await call("/auth/me", temporaryCookie)).status, 401);
      assert.equal((await call("/courses/mine", instructorCookie)).status, 200);
      assert.equal((await call("/auth/login", null, "POST", { email: instructor.email, password: temporaryPassword })).status, 401);
      assert.equal((await call("/admin/instructors", instructorCookie, "POST", { name: "Blocked", email: "bad@example.invalid", temporaryPassword })).status, 403);
    });
    await t.test("user lists are paginated, searchable, admin-only and exclude all credentials", async () => {
      assert.equal((await call("/admin/users", studentCookie)).status, 403);
      assert.equal((await call("/admin/overview", instructorCookie)).status, 403);
      const response = await call("/admin/users?role=instructor&search=TEACHER&limit=1", adminCookie);
      assert.equal(response.status, 200); assert.equal(response.body.data.total, 1); assert.equal(response.body.data.users.length, 1);
      for (const key of ["password", "authVersion", "bootstrapKey", "resetPasswordToken", "resetPasswordExpires"]) assert.equal(response.body.data.users[0][key], undefined);
      assert.equal((await call("/admin/users?limit=1000", adminCookie)).status, 400);
      assert.equal((await call("/admin/users?search=%5B", adminCookie)).status, 200);
    });
    await t.test("suspension revokes cookies and cannot lock out administrators; restoration does not revive sessions", async () => {
      const path = `/admin/users/${instructor.id}/access`;
      assert.equal((await call(path, studentCookie, "PATCH", { status: "suspended" })).status, 403);
      assert.equal((await call(path, adminCookie, "PATCH", { status: "suspended" }, { Origin: "https://evil.example" })).status, 403);
      assert.equal((await call(path, adminCookie, "PATCH", { status: "suspended" })).status, 200);
      assert.equal((await call(path, adminCookie, "PATCH", { status: "suspended" })).status, 200);
      assert.equal((await call("/auth/me", instructorCookie)).status, 401);
      assert.equal((await call(`/admin/users/${admin._id}/access`, adminCookie, "PATCH", { status: "suspended" })).status, 403);
      assert.equal((await call(`/admin/users/${admin._id}/temporary-password`, adminCookie, "POST", { temporaryPassword: password() })).status, 403);
      assert.equal((await call(path, adminCookie, "PATCH", { status: "active" })).status, 200);
      assert.equal((await call("/auth/me", instructorCookie)).status, 401);
      assert.equal((await call("/admin/users", adminCookie)).status, 200);
    });
    await t.test("admin password replacement revokes prior sessions and expires; suspension survives reset", async () => {
      const next = password();
      assert.equal((await call(`/admin/users/${instructor.id}/temporary-password`, adminCookie, "POST", { temporaryPassword: next })).status, 200);
      let result = await call("/auth/login", null, "POST", { email: instructor.email, password: next }); assert.equal(result.status, 200);
      await User.updateOne({ _id: instructor.id }, { temporaryPasswordExpiresAt: new Date(0) });
      assert.equal((await call("/auth/me", result.cookie)).status, 401);
      assert.equal((await call("/auth/login", null, "POST", { email: instructor.email, password: next })).status, 403);
      await call(`/admin/users/${instructor.id}/access`, adminCookie, "PATCH", { status: "suspended" });
      const replacement = await call(`/admin/users/${instructor.id}/temporary-password`, adminCookie, "POST", { temporaryPassword: next }); assert.equal(replacement.body.data.user.status, "suspended");
      assert.equal((await call("/auth/login", null, "POST", { email: instructor.email, password: next })).status, 403);
      await call(`/admin/users/${instructor.id}/access`, adminCookie, "PATCH", { status: "active" });
      result = await call("/auth/login", null, "POST", { email: instructor.email, password: next });
      const races = await Promise.all([call("/auth/change-password", result.cookie, "POST", { currentPassword: next, password: password() }), call("/auth/change-password", result.cookie, "POST", { currentPassword: next, password: password() })]);
      assert.deepEqual(races.map((r) => r.status).sort(), [200, 409]); instructorCookie = races.find((r) => r.status === 200).cookie;
    });
    await t.test("course transfer switches instructor access, preserves student assignments and hides video keys", async () => {
      const otherPassword = password(); const other = await User.create({ name: "Existing teacher", email: "existing@example.invalid", role: "instructor", password: otherPassword });
      // Existing accounts without newly introduced fields stay usable.
      await User.collection.updateOne({ _id: other._id }, { $unset: { status: 1, mustChangePassword: 1, authVersion: 1 } });
      const otherCookie = (await call("/auth/login", null, "POST", { email: other.email, password: otherPassword })).cookie;
      assert.equal((await call("/courses/mine", otherCookie)).status, 200);
      const category = await Category.create({ name: "General" });
      const course = await Course.create({ title: "Course", description: "Fixture", instructor: instructor.id, category: category._id, isPublished: true });
      const module = await Module.create({ title: "Module", course: course._id, order: 0 });
      const lesson = await Lesson.create({ title: "Video", course: course._id, module: module._id, order: 0 });
      const video = await VideoAsset.create({ owner: instructor.id, course: course._id, lesson: lesson._id, fingerprint: "test", filename: "private.mp4", size: 200, chunkSize: 0, chunkCount: 0, status: "uploading", uploadMode: "direct", objectKey: "secret-storage-key", expiresAt: new Date(Date.now() + 3600000) });
      await Lesson.updateOne({ _id: lesson._id }, { video: video._id });
      await Enrollment.create({ student: student.id, course: course._id, assignedBy: admin._id });
      const route = `/admin/courses/${course._id}/instructor`;
      assert.equal((await call(route, instructorCookie, "PATCH", { instructorId: other._id })).status, 403);
      assert.equal((await call(route, adminCookie, "PATCH", { instructorId: other._id })).status, 409);
      await VideoAsset.updateOne({ _id: video._id }, { status: "ready" });
      assert.equal((await call(route, adminCookie, "PATCH", { instructorId: other._id })).status, 200);
      assert.equal((await call(route, adminCookie, "PATCH", { instructorId: other._id })).status, 200);
      assert.equal((await call(`/courses/mine/${course._id}`, instructorCookie)).status, 403);
      assert.equal((await call(`/courses/mine/${course._id}`, otherCookie)).status, 200);
      assert.equal((await call(`/courses/${course._id}`, studentCookie)).status, 200);
      const inventory = await call("/admin/videos", adminCookie); assert.equal(inventory.body.data.total, 1); assert.equal(JSON.stringify(inventory).includes("secret-storage-key"), false);
      assert.equal((await call("/admin/videos", instructorCookie)).status, 403);
      assert.equal((await call("/admin/courses", adminCookie)).body.data.total, 1);
    });
    await t.test("audit logs record privileged intent/results with no passwords or session material", async () => {
      const result = await call("/admin/activity?limit=100", adminCookie); assert.equal(result.status, 200);
      assert.ok(result.body.data.events.some((event) => event.action === "instructor.created" && event.outcome === "succeeded"));
      assert.ok(result.body.data.events.some((event) => event.outcome === "rejected"));
      const raw = JSON.stringify(await AuditEvent.find().lean());
      for (const secret of [temporaryPassword, adminPassword, adminCookie, instructorCookie]) assert.equal(raw.includes(secret), false);
      assert.equal((await call("/admin/activity", studentCookie)).status, 403);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    assert.match(mongoose.connection.name, /^lms_test_/); await mongoose.connection.dropDatabase(); await mongoose.disconnect();
  }
});
