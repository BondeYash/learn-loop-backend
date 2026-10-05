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
import Enrollment from "../models/Enrollment.js";
import PaymentOrder, { LivePaymentOrder } from "../models/PaymentOrder.js";
import { acquisitionModels, AcquisitionConfig, AcquisitionChoice, AcquisitionVisit, InterestRequest, SourceLink } from "../models/Acquisition.js";
import { captureAttribution, boundedCreate, requestToken, retentionDays } from "../services/acquisition.js";
test("optional bounded acquisition, private requests and canonical aggregates", { timeout: 90000 }, async (t) => {
  process.env.NODE_ENV = "test";
  await mongoose.connect(`mongodb://127.0.0.1:${process.env.TEST_MONGO_PORT || 27018}/lms_test_${crypto.randomBytes(6).toString("hex")}`, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([User, Session, Course, Category, Module, Lesson, Enrollment, PaymentOrder, LivePaymentOrder, ...acquisitionModels].map((m) => m.init()));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); }), base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, who, method = "GET", body) => { const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(who?.cookie ? { cookie: who.cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json(), cookie: r.headers.get("set-cookie")?.split(";")[0] }; };
  try {
    const users = {};
    for (const [name, role] of [["owner", "instructor"], ["other", "instructor"], ["student", "student"], ["admin", "admin"]]) { const password = crypto.randomBytes(24).toString("hex"), user = await User.create({ name, role, email: `${name}@example.invalid`, password }); users[name] = { id: user._id, _id: user._id, role, cookie: (await call("/auth/login", null, "POST", { email: user.email, password })).cookie }; }
    const category = await Category.create({ name: "Synthetic attribution" }), course = await Course.create({ title: "Synthetic acquisition course", description: "Synthetic fixture", instructor: users.owner.id, category: category._id, isPublished: true, visibility: "public" }), module = await Module.create({ course: course._id, title: "Fixture chapter", order: 0 }), lesson = await Lesson.create({ course: course._id, module: module._id, title: "Fixture sample", contentType: "text", content: "Open authored fixture", order: 0 });
    await Course.updateOne({ _id: course._id }, { previewLesson: lesson._id });
    const ownerPath = `/courses/${course._id}/acquisition`, publicPath = `/public/courses/${course._id}`;
    let source, interest;
    await t.test("collection defaults off; private reports require course ownership and actual reviewed notice", async () => {
      assert.equal((await call(publicPath + "/acquisition")).body.data.measurementEnabled, false);
      for (const [who, status] of [[null,401], [users.student,403], [users.other,403]]) for (const path of ["config", "sources", "report", "interest"]) assert.equal((await call(`${ownerPath}/${path}`, who)).status, status);
      const empty = (await call(ownerPath + "/report", users.admin)).body.data; assert.ok(Object.values(empty.totals).every((n) => n === 0)); assert.equal(empty.rows[0].label, "Unknown / unattributed"); assert.ok(!JSON.stringify(empty).includes("conversionRate"));
      const values = { measurementEnabled: true, interestEnabled: true, policyReviewed: true, version: 0 };
      assert.equal((await call(ownerPath + "/config", users.owner, "PUT", values)).status, 409);
      await Course.updateOne({ _id: course._id }, { privacyPolicyUrl: "https://example.invalid/privacy" }); course.privacyPolicyUrl = "https://example.invalid/privacy";
      assert.equal((await call(ownerPath + "/config", users.owner, "PUT", { ...values, policyReviewed: false })).status, 409);
      assert.equal((await call(ownerPath + "/config", users.owner, "PUT", values)).status, 200);
      assert.equal((await call(ownerPath + "/config", users.owner, "PUT", values)).status, 409);
      await Course.updateOne({ _id: course._id }, { privacyPolicyUrl: "https://example.invalid/new-notice" }); assert.equal((await call(publicPath + "/acquisition")).body.data.interestEnabled, false);
      await Course.updateOne({ _id: course._id }, { privacyPolicyUrl: course.privacyPolicyUrl });
    });
    await t.test("source creation is validated, bounded, retry-safe and versioned", async () => {
      const body = { channel: "referral", label: "course-page", requestId: crypto.randomUUID() };
      assert.equal((await call(ownerPath + "/sources", users.owner, "POST", { ...body, label: "person@example.invalid" })).status, 400);
      assert.equal((await call(ownerPath + "/sources", users.other, "POST", body)).status, 403);
      const made = await Promise.all([call(ownerPath + "/sources", users.owner, "POST", body), call(ownerPath + "/sources", users.owner, "POST", body)]); made.forEach((r) => assert.equal(r.status, 201)); source = made[0].body.data.source; assert.equal(made[1].body.data.source.id, source.id); assert.match(source.code, /^[a-f\d]{12}$/); assert.equal(await SourceLink.countDocuments(), 1);
      assert.equal((await call(`${ownerPath}/sources/${source.id}`, users.admin, "PUT", { active: false, version: 1 })).status, 200);
      assert.equal((await call(`${ownerPath}/sources/${source.id}`, users.admin, "PUT", { active: true, version: 1 })).status, 409);
      source = (await call(`${ownerPath}/sources/${source.id}`, users.owner, "PUT", { active: true, version: 2 })).body.data.source;
    });
    await t.test("only explicit consent writes anonymous visits; untrusted fields cannot create canonical records", async () => {
      const body = { consent: true, sourceCode: source.code, requestId: crypto.randomUUID() };
      assert.equal((await call(publicPath + "/visits", null, "POST", { ...body, consent: false })).status, 400);
      assert.equal((await call(publicPath + "/visits", null, "POST", { ...body, email: "private@example.invalid" })).status, 400);
      assert.equal((await call(publicPath + "/visits", null, "POST", { ...body, sourceCode: "arbitrary-query-url" })).status, 400);
      const results = await Promise.all(Array.from({ length: 4 }, () => call(publicPath + "/visits", null, "POST", body))); results.forEach((r) => assert.equal(r.status, 200));
      assert.equal(await AcquisitionVisit.countDocuments(), 1);
      assert.equal((await call(publicPath + "/visits", null, "POST", { ...body, sourceCode: "000000000000", requestId: crypto.randomUUID() })).status, 200);
      const stored = await AcquisitionVisit.find().lean(); for (const r of stored) for (const key of ["ip", "email", "user", "student", "referrer", "userAgent", "sourceCode", "requestId"]) assert.equal(r[key], undefined);
      assert.equal(await Enrollment.countDocuments(), 0); assert.equal(await LivePaymentOrder.countDocuments(), 0);
      assert.equal((await call(publicPath + "/preview")).status, 200);
    });
    await t.test("minimal contacts, optional marketing, private pagination/status/erasure and anonymous rate limit", async () => {
      const body = { email: "request@example.invalid", purpose: "demo", contactAcknowledged: true, marketingConsent: false, requestId: crypto.randomUUID() };
      assert.equal((await call(publicPath + "/interest", null, "POST", { ...body, contactAcknowledged: false })).status, 400);
      assert.equal((await call(publicPath + "/interest", null, "POST", { ...body, rawQuery: "secret" })).status, 400);
      const created = await Promise.all([call(publicPath + "/interest", null, "POST", body), call(publicPath + "/interest", null, "POST", body)]); created.forEach((r) => { assert.equal(r.status, 200); assert.ok(!JSON.stringify(r.body).includes(body.email)); }); assert.equal(await InterestRequest.countDocuments(), 1);
      interest = (await call(ownerPath + "/interest", users.owner)).body.data.requests[0]; assert.equal(interest.marketingConsent, false); assert.equal(interest.marketingConsentAt, null);
      assert.equal((await call(publicPath + "/interest", null, "POST", { ...body, requestId: crypto.randomUUID(), marketingConsent: true })).status, 200);
      assert.equal((await call(publicPath + "/interest", null, "POST", body)).status, 429);
      assert.equal((await call(`${ownerPath}/interest/${interest.id}`, users.other, "PUT", { status: "contacted", version: 1 })).status, 403);
      assert.equal((await call(`${ownerPath}/interest/${interest.id}`, users.owner, "PUT", { status: "contacted", version: 1 })).status, 200);
      assert.equal((await call(`${ownerPath}/interest/${interest.id}`, users.owner, "PUT", { status: "closed", version: 1 })).status, 409);
      assert.equal((await call(ownerPath + "/interest?page=0", users.owner)).status, 400);
      assert.equal((await call(ownerPath + "/interest?email=secret", users.owner)).status, 400);
      assert.ok(!JSON.stringify((await call(publicPath)).body).includes(body.email));
      assert.equal((await call(`${ownerPath}/interest/${interest.id}`, users.owner, "DELETE", { version: 2 })).status, 200);
    });
    await t.test("attribution needs consent and a registered source, preserves first choice and never establishes access", async () => {
      await captureAttribution(course, users.student, { consent: false, sourceCode: source.code }); assert.equal(await AcquisitionChoice.countDocuments(), 0);
      await captureAttribution(course, users.student, { consent: true, sourceCode: "000000000000" }); assert.equal(await AcquisitionChoice.countDocuments(), 0);
      const enroll = await call(`/courses/${course._id}/enroll`, users.student, "POST", { quotedAmountMinor: 0, attribution: { consent: true, sourceCode: source.code } }); assert.equal(enroll.status, 200);
      assert.equal(await AcquisitionChoice.countDocuments(), 1); assert.equal(await Enrollment.countDocuments({ publicFreeEnrollment: true }), 1);
      const second = await SourceLink.create({ course: course._id, slot: 1, code: "111111111111", channel: "social", label: "course-social", requestToken: requestToken(crypto.randomUUID()) });
      await captureAttribution(course, users.student, { consent: true, sourceCode: second.code }); assert.equal(String((await AcquisitionChoice.findOne()).source), source.id);
      assert.equal((await call(`${ownerPath}/choice`, users.owner, "DELETE")).status, 403);
      assert.equal((await call(`${ownerPath}/choice`, users.student, "DELETE")).status, 200); assert.equal(await AcquisitionChoice.countDocuments(), 0); assert.equal(await Enrollment.countDocuments(), 1);
      await captureAttribution(course, users.student, { consent: true, sourceCode: source.code });
    });
    await t.test("canonical reports exclude test/pending payments and account for refunds/disputes/reversals", async () => {
      const ids = Array.from({ length: 7 }, () => new mongoose.Types.ObjectId()), statuses = ["paid", "partially_refunded", "refunded", "disputed", "reversed", "pending"];
      for (let i = 0; i < statuses.length; i++) { await LivePaymentOrder.create({ student: ids[i], course: course._id, instructor: users.owner.id, title: course.title, amountMinor: 10000, refundedMinor: statuses[i] === "partially_refunded" ? 2500 : statuses[i] === "refunded" ? 10000 : 0, testMode: false, status: statuses[i], requestKey: crypto.randomUUID(), checkoutExpiresAt: new Date(Date.now() + 10000), enrollmentType: "public" }); await Enrollment.create({ course: course._id, student: ids[i], publicPurchaseModes: ["live"] }); }
      await PaymentOrder.create({ student: ids[6], course: course._id, instructor: users.owner.id, title: course.title, amountMinor: 999999, testMode: true, status: "paid", requestKey: crypto.randomUUID(), checkoutExpiresAt: new Date(Date.now() + 10000), enrollmentType: "public" }); await Enrollment.create({ course: course._id, student: ids[6], publicPurchaseModes: ["test"] });
      const r = (await call(ownerPath + "/report", users.owner)).body.data; assert.equal(r.totals.freeEnrollments, 1); assert.equal(r.totals.livePaidEnrollments, 1); assert.equal(r.totals.receiptsMinor, 17500); assert.equal(r.totals.partialRefunds, 1); assert.equal(r.totals.fullRefunds, 1); assert.equal(r.totals.disputes, 1); assert.equal(r.totals.reversals, 1); assert.equal(r.totals.paidOrders, 1); assert.equal(r.totals.visits, 2); assert.equal(r.rows.find((row) => row.id === source.id).freeEnrollments, 1); assert.equal(r.rows.find((row) => row.id === "unknown").livePaidEnrollments, 1);
      const text = JSON.stringify(r); for (const secret of ["request@example.invalid", String(users.student.id), String(ids[0]), "requestKey", "stripeSessionId"]) assert.ok(!text.includes(secret));
      await AcquisitionChoice.updateMany({}, { expiresAt: new Date(Date.now() - 10000) }); await AcquisitionVisit.updateMany({}, { expiresAt: new Date(Date.now() - 10000) }); await InterestRequest.updateMany({}, { expiresAt: new Date(Date.now() - 10000) });
      const expired = (await call(ownerPath + "/report", users.owner)).body.data; assert.equal(expired.totals.visits, 0); assert.equal(expired.totals.receiptsMinor, 17500); assert.equal(expired.rows.find((row) => row.id === "unknown").freeEnrollments, 1); assert.equal((await call(ownerPath + "/interest", users.owner)).body.data.total, 0);
    });
    await t.test("caps enforce races, pagination is bounded, collection stops for unpublished/archived courses", async () => {
      const capped = new mongoose.Types.ObjectId(); await SourceLink.insertMany(Array.from({ length: 19 }, (_, slot) => ({ course: capped, slot, code: crypto.randomBytes(6).toString("hex"), requestToken: requestToken(crypto.randomUUID()), channel: "other", label: "generic-campaign" })));
      const made = await Promise.allSettled([1,2].map(() => boundedCreate(SourceLink, capped, 20, { code: crypto.randomBytes(6).toString("hex"), requestToken: requestToken(crypto.randomUUID()), channel: "other", label: "last-source" }))); assert.equal(made.filter((r) => r.status === "fulfilled").length, 1); assert.equal(await SourceLink.countDocuments({ course: capped }), 20);
      await InterestRequest.insertMany(Array.from({ length: 41 }, (_, slot) => ({ course: course._id, slot: slot + 2, email: "synthetic@example.invalid", purpose: "interest", requestToken: requestToken(crypto.randomUUID()), expiresAt: new Date(Date.now() + 86400000) }))); assert.equal((await call(ownerPath + "/interest", users.admin)).body.data.requests.length, 20); assert.equal((await call(ownerPath + "/interest?page=3", users.admin)).body.data.requests.length, 1);
      await Course.updateOne({ _id: course._id }, { isPublished: false }); assert.equal((await call(publicPath + "/acquisition")).status, 404); await Course.updateOne({ _id: course._id }, { isPublished: true, archivedAt: new Date() }); assert.equal((await call(publicPath + "/acquisition")).status, 404); assert.equal((await call(ownerPath + "/report", users.owner)).status, 200);
      const item = await InterestRequest.findOne({ course: course._id, ...{ expiresAt: { $gt: new Date() } } }); assert.equal((await call(`${ownerPath}/interest/${item._id}`, users.admin, "DELETE", { version: item.version })).status, 200);
      assert.equal(retentionDays(), 90); process.env.ACQUISITION_RETENTION_DAYS = "181"; assert.equal(retentionDays(), 90); delete process.env.ACQUISITION_RETENTION_DAYS;
    });
    await t.test("visit request rate is finite and required indexes exist", async () => { for (let i = 0; i < 22; i++) assert.equal((await call(publicPath + "/visits", null, "POST", { consent: false, requestId: crypto.randomUUID() })).status, 400); assert.equal((await call(publicPath + "/visits", null, "POST", {})).status, 429); const indexes = await AcquisitionVisit.collection.indexes(); assert.ok(indexes.some((i) => i.expireAfterSeconds === 0)); assert.ok(indexes.some((i) => i.unique && i.key.requestToken)); });
  } finally { await new Promise((resolve) => server.close(resolve)); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
});
