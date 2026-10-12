import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import mongoose from "mongoose";
import app from "../app.js";
import User from "../models/User.js";
import Course from "../models/Course.js";
import Category from "../models/Category.js";
import Module from "../models/Module.js";
import Lesson from "../models/Lesson.js";
import Enrollment from "../models/Enrollment.js";
import Assessment from "../models/Assessment.js";
import { paymentOrderModel } from "../models/PaymentOrder.js";
import { razorpayEventModel } from "../models/RazorpayEvent.js";
import { razorpayClient, razorpayReadiness, validSignature } from "../services/razorpayClient.js";
import { rupeesToMinor } from "../services/coursePricing.js";
import { providerFixture } from "./razorpayFixture.js";

const settings = mode => ({ RAZORPAY_MODE: mode, RAZORPAY_KEY_ID: `rzp_${mode}_synthetic`, RAZORPAY_KEY_SECRET: "synthetic-api-secret", RAZORPAY_WEBHOOK_SECRET: "synthetic-webhook-secret", CLIENT_URL: "https://frontend.fixture.invalid" });
const sign = (body, secret) => crypto.createHmac("sha256", secret).update(body).digest("hex");
test("exact INR amounts, explicit mode, private credentials and frontend origin", () => {
  for (const [value, amount] of [[0,0],["0.50",50],["12.34",1234],[1999.99,199999],["999999.99",99999999]]) assert.equal(rupeesToMinor(value),amount);
  for (const value of [-1,NaN,Infinity,"1.001","1e3","0.49","1000000",{},null,"abc"]) assert.throws(() => rupeesToMinor(value));
  for (const mode of ["test", "live"]) {
    const env = settings(mode); assert.equal(razorpayReadiness(env).configured, true);
    for (const override of [{ RAZORPAY_MODE: "sandbox" }, { RAZORPAY_KEY_ID: `rzp_${mode === "test" ? "live" : "test"}_synthetic` }, { RAZORPAY_KEY_SECRET: "" }, { RAZORPAY_WEBHOOK_SECRET: "" }, { RAZORPAY_WEBHOOK_SECRET: "REPLACE_PRIVATELY" }, { CLIENT_URL: "https://user@fixture.invalid" }, { CLIENT_URL: "https://fixture.invalid/path" }]) assert.equal(razorpayReadiness({ ...env, ...override }).configured, false);
  }
  assert.equal(razorpayReadiness({ ...settings("live"), CLIENT_URL: "http://localhost:5173" }).configured, false);
  assert.equal(razorpayReadiness({ ...settings("test"), CLIENT_URL: "http://localhost:5173" }).configured, true);
  assert.equal(razorpayReadiness({ ...settings("test"), RAZORPAY_MODE: undefined }).configured, true);
  assert.ok(validSignature("order_synthetic|pay_synthetic", sign("order_synthetic|pay_synthetic", "secret"), "secret"));
  assert.equal(validSignature("changed", sign("original", "secret"), "secret"), false);
});
test("provider client confines paths, authenticates privately and redacts provider failures", async () => {
  const env = settings("test"), requests = [];
  const client = razorpayClient(env, async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify({ entity: "order", id: "order_synthetic" })); });
  await client.createOrder({ amount: 100, currency: "INR" }); await client.fetchOrder("order_synthetic"); await client.fetchOrders({ receipt: "ll_test_synthetic", count: 100, skip: 0 }); await client.fetchPayment("pay_synthetic");
  assert.ok(requests.every(r => r.url.startsWith("https://api.razorpay.com/v1/")));
  assert.equal(requests[0].options.method, "POST"); assert.equal(requests[0].options.redirect, "error");
  assert.equal(Buffer.from(requests[0].options.headers.Authorization.slice(6), "base64").toString(), `${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.throws(() => client.fetchOrder("../payments/pay_secret"), /Invalid Razorpay identifier/);
  for (const status of [400,401,403,422,500]) {
    const failing = razorpayClient(env, async () => new Response("private-provider-detail", { status }));
    await assert.rejects(failing.createOrder({}), e => { assert.equal(e.providerRejected, status < 500); assert.ok(!e.message.includes("private-provider-detail")); return true; });
  }
  await assert.rejects(razorpayClient(env, async () => { throw new Error(env.RAZORPAY_KEY_SECRET); }).fetchOrder("order_synthetic"), e => !e.message.includes(env.RAZORPAY_KEY_SECRET));
});

for (const mode of ["test", "live"]) test(`Razorpay ${mode}: real cookie auth, raw signed HTTP webhooks and isolated MongoDB; synthetic provider`, { timeout: 120000 }, async t => {
  Object.assign(process.env, settings(mode), { NODE_ENV: "test" });
  await mongoose.connect(`mongodb://127.0.0.1:${process.env.TEST_MONGO_PORT || 27018}/lms_test_payments_${crypto.randomBytes(6).toString("hex")}`, { serverSelectionTimeoutMS: 5000 });
  await Promise.all(Object.values(mongoose.models).map(async m => { await m.init(); await m.createIndexes(); }));
  const Model = paymentOrderModel(mode), Events = razorpayEventModel(mode), testMode = mode === "test", fake = providerFixture();
  app.locals.razorpayClient = fake;
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, who, method = "GET", body, extra = {}) => {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(who?.cookie ? { cookie: who.cookie } : {}), ...extra }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const webhook = async (event, { id = crypto.randomUUID(), bad = false, raw = JSON.stringify(event) } = {}) => {
    const response = await fetch(base + "/payments/razorpay/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Razorpay-Signature": sign(raw, bad ? "wrong" : process.env.RAZORPAY_WEBHOOK_SECRET), "X-Razorpay-Event-Id": id }, body: raw });
    return { status: response.status, body: await response.json() };
  };
  let sequence = 0, owner, course, publicCourse;
  const user = async (role = "student") => {
    const password = crypto.randomBytes(20).toString("hex"), u = await User.create({ name: `Synthetic ${++sequence}`, email: `synthetic${sequence}@fixture.invalid`, password, role });
    const login = await call("/auth/login", null, "POST", { email: u.email, password }); assert.equal(login.status, 200);
    return { id: u._id, cookie: login.cookie };
  };
  const learner = async (assigned = true) => { const u = await user(); if (assigned) await Enrollment.create({ student: u.id, course: course._id, assignedBy: owner.id }); return u; };
  const checkout = (u, { key = crypto.randomUUID(), selected = course, amount = 12345 } = {}) => call("/payments/checkout", u, "POST", { courseId: String(selected._id), quotedAmountMinor: amount }, { "Idempotency-Key": key });
  const ready = async u => { const r = await checkout(u); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.data; };
  const verify = (u, data, p, overrides = {}) => call(`/payments/orders/${data.order.id}/verify`, u, "POST", { razorpay_order_id: data.checkout.orderId, razorpay_payment_id: p.id, razorpay_signature: sign(`${data.checkout.orderId}|${p.id}`, process.env.RAZORPAY_KEY_SECRET), ...overrides });
  const refresh = (u, data) => call(`/payments/orders/${data.order.id}/refresh`, u, "POST", {});
  const state = async data => Model.findById(data.order.id).select("+razorpayOrderId +checkoutContract");
  try {
    owner = await user("instructor"); const category = await Category.create({ name: "Synthetic payments" });
    const makeCourse = async visibility => {
      const c = await Course.create({ title: `Synthetic ${visibility} paid course`, description: "No production content", category: category._id, instructor: owner.id, isPublished: true, price: 123.45, visibility });
      const chapter = await Module.create({ course: c._id, title: "Lessons", order: 0 });
      await Lesson.create({ course: c._id, module: chapter._id, title: "Private lesson", contentType: "text", content: "Synthetic protected learning content", order: 0 }); return c;
    };
    course = await makeCourse("private"); publicCourse = await makeCourse("public");
    await t.test("authorization, server price, readiness and payment DTO privacy", async () => {
      const u = await learner(), stranger = await learner(false);
      assert.equal((await call(`/courses/${course._id}`, u)).status, 402);
      assert.equal((await checkout(stranger)).status, 201); assert.equal((await checkout(owner)).status, 403); assert.equal((await checkout(null)).status, 401);
      assert.equal((await checkout(u, { amount: 12000 })).status, 409); assert.equal((await checkout(u, { key: "short" })).status, 400);
      const data = await ready(u); assert.equal(data.order.provider, "razorpay"); assert.equal(data.order.testMode, testMode); assert.equal(data.checkout.amount, 12345); assert.equal(data.checkout.keyId, process.env.RAZORPAY_KEY_ID); assert.equal(data.order.checkoutExpiresAt, undefined);
      assert.equal((await call(`/courses/${course._id}`, owner, "PATCH", { price: "0.50" })).status, 400);
      const safe = JSON.stringify((await call("/payments/orders", u)).body);
      for (const marker of ["requestKey", "razorpayOrderId", "razorpayPaymentId", "checkoutContract", process.env.RAZORPAY_KEY_SECRET, process.env.RAZORPAY_WEBHOOK_SECRET]) assert.ok(!safe.includes(marker));
      assert.equal((await call(`/payments/orders/${data.order.id}`, stranger)).status, 404);
      assert.equal((await refresh(stranger, data)).status, 404);
      const original = process.env.RAZORPAY_KEY_ID; process.env.RAZORPAY_KEY_ID = `rzp_${testMode ? "live" : "test"}_synthetic`;
      try { assert.equal((await checkout(u)).status, 503); } finally { process.env.RAZORPAY_KEY_ID = original; }
      const health = await call("/payments/razorpay/webhook"); assert.equal(health.status,200); assert.equal(health.body.data.configured,true); assert.equal(health.body.data.mode,mode);
    });
    await t.test("same attempt and concurrent submissions create a single provider order; prior quote stays fixed", async () => {
      const u = await learner(), key = crypto.randomUUID(), count = fake.creates;
      fake.beforeReturn = () => new Promise(resolve => setTimeout(resolve,30));
      const results = await Promise.all([checkout(u,{key}), checkout(u,{key}), checkout(u,{key})]); fake.beforeReturn = null;
      assert.ok(results.some(r => r.status === 201)); assert.ok(results.every(r => [201,503].includes(r.status))); assert.equal(fake.creates,count+1);
      const first = results.find(r => r.status === 201).body.data, second = await checkout(u,{key}); assert.equal(second.body.data.checkout.orderId,first.checkout.orderId);
      await Course.updateOne({_id:course._id},{$set:{price:200}});
      try { const quote=(await call(`/payments/courses/${course._id}/quote`,u)).body.data.quote; assert.equal(quote.amountMinor,12345); assert.equal(quote.currentAmountMinor,20000); assert.equal((await checkout(u,{key})).status,201); }
      finally { await Course.updateOne({_id:course._id},{$set:{price:123.45}}); }
    });
    await t.test("lost creation response recovers exact receipt and never repeats an uncertain POST", async () => {
      const u = await learner(), key = crypto.randomUUID(), count = fake.creates;
      fake.beforeReturn = () => { throw new Error("Synthetic lost response"); };
      assert.equal((await checkout(u,{key})).status,500); fake.beforeReturn = null;
      const recovered = await checkout(u,{key}); assert.equal(recovered.status,201,JSON.stringify(recovered)); assert.equal(fake.creates,count+1);
      const v=await learner();fake.beforeReturn=order=>{fake.orders.delete(order.id);throw new Error("Synthetic unknown outcome");};
      const k=crypto.randomUUID();assert.equal((await checkout(v,{key:k})).status,500);fake.beforeReturn=null;const c=fake.creates;
      assert.equal((await checkout(v,{key:k})).status,503);assert.equal(fake.creates,c);
    });
    await t.test("definitive provider rejection finishes attempt and permits a deliberate new attempt", async () => {
      const u=await learner();fake.rejectCreate=true;assert.equal((await checkout(u)).status,500);fake.rejectCreate=false;
      const failed=await Model.findOne({student:u.id});assert.equal(failed.status,"failed");assert.equal(failed.active,false);
      assert.equal((await checkout(u)).status,201);
    });
    await t.test("authorized payments and forged callbacks never unlock; captured payment verifies and survives reload", async () => {
      const u=await learner(), data=await ready(u), authorized=fake.pay(data.checkout.orderId,"authorized");
      assert.equal((await verify(u,data,authorized)).body.data.order.status,"pending");assert.equal((await call(`/courses/${course._id}`,u)).status,402);
      assert.equal((await verify(u,data,authorized,{razorpay_signature:"0".repeat(64)})).status,400);
      const other=await learner(), foreign=await ready(other), foreignPay=fake.pay(foreign.checkout.orderId);
      assert.equal((await verify(u,data,foreignPay)).status,409);
      const p=fake.pay(data.checkout.orderId);let result=await verify(u,data,p);assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.data.order.canAccess,true);
      assert.equal((await call(`/courses/${course._id}`,u)).status,200);assert.equal((await verify(u,data,p)).status,200);assert.equal((await checkout(u)).status,409);
      fake.unavailable=true;try {result=await refresh(u,data);assert.equal(result.status,500);assert.equal((await call(`/courses/${course._id}`,u)).status,200);}finally{fake.unavailable=false;}
      assert.equal((await state(data)).status,"paid");
    });
    await t.test("raw webhook signatures, bad JSON, oversize body, duplicates and late failed events", async () => {
      const u=await learner(),data=await ready(u),p=fake.pay(data.checkout.orderId),event=fake.event("payment.captured",p),id=crypto.randomUUID();
      assert.equal((await webhook(event,{bad:true})).status,400);assert.equal((await webhook(event,{raw:'{"broken"'})).status,400);
      assert.equal((await webhook(event,{raw:"x".repeat(256*1024+1)})).status,413);
      assert.equal((await webhook(event,{id})).status,200);assert.equal((await webhook(event,{id})).body.duplicate,true);
      assert.equal((await webhook(fake.event("payment.failed",{...p,status:"failed"}))).status,200);assert.equal((await state(data)).status,"paid");
      assert.equal((await webhook(fake.event("order.paid",fake.orders.get(p.order_id)))).status,200);
      assert.equal((await call(`/courses/${course._id}`,u)).status,200);assert.equal(await Events.countDocuments({_id:id}),1);
      // Header absent: the raw payload digest is a stable fallback identifier.
      const raw=JSON.stringify(event), response=await fetch(base+"/payments/razorpay/webhook",{method:"POST",headers:{"Content-Type":"application/json","X-Razorpay-Signature":sign(raw,process.env.RAZORPAY_WEBHOOK_SECRET)},body:raw});assert.equal(response.status,200);
    });
    await t.test("webhook failure retries, in-flight duplicate delivery and canonical mismatch", async () => {
      const u=await learner(),data=await ready(u),p=fake.pay(data.checkout.orderId),event=fake.event("payment.captured",p),id=crypto.randomUUID();
      fake.unavailable=true;assert.equal((await webhook(event,{id})).status,500);fake.unavailable=false;
      assert.equal((await Events.findById(id)).status,"processing");assert.equal((await webhook(event,{id})).status,200);
      const v=await learner(),d=await ready(v),q=fake.pay(d.checkout.orderId),eid=crypto.randomUUID();
      await Events.create({_id:eid,type:"payment.captured",leaseUntil:new Date(Date.now()+10000),token:"fixture"});assert.equal((await webhook(fake.event("payment.captured",q),{id:eid})).status,503);
      const remote=fake.orders.get(d.checkout.orderId);remote.amount+=100;assert.equal((await refresh(v,d)).status,409);remote.amount-=100;
      const payment=fake.payments.get(q.id);payment.currency="USD";assert.equal((await refresh(v,d)).status,409);payment.currency="INR";
      assert.equal((await state(d)).status,"pending");assert.equal((await refresh(v,d)).body.data.order.canAccess,true);
    });
    await t.test("failed attempts can be followed by capture; canonical partial/full refunds relock and cannot regress", async () => {
      const u=await learner(),data=await ready(u),failure=fake.pay(data.checkout.orderId,"failed");
      assert.equal((await webhook(fake.event("payment.failed",failure))).status,200);assert.equal((await state(data)).status,"failed");
      const p=fake.pay(data.checkout.orderId);assert.equal((await webhook(fake.event("payment.captured",p))).status,200);assert.equal((await state(data)).status,"paid");
      const reads=fake.paymentReads;fake.refund(p.id,1000);
      assert.equal((await webhook(fake.event("refund.processed",{id:"rfnd_synthetic",payment_id:p.id,amount:1000,status:"processed"}))).status,200);assert.equal(fake.paymentReads,reads);
      assert.equal((await state(data)).status,"partially_refunded");assert.equal((await call(`/courses/${course._id}`,u)).status,402);
      fake.refund(p.id,12345);assert.equal((await webhook(fake.event("refund.processed",{payment_id:p.id}))).status,200);assert.equal((await state(data)).status,"refunded");
      fake.refund(p.id,0);assert.equal((await refresh(u,data)).status,503);assert.equal((await state(data)).refundedMinor,12345);
    });
    await t.test("public purchase auto-enrolls once and stays accessible when free-enrollment policy changes", async () => {
      const u=await learner(false),r=await checkout(u,{selected:publicCourse});assert.equal(r.status,201);const data=r.body.data;
      assert.equal(await Enrollment.countDocuments({student:u.id,course:publicCourse._id}),0);
      const p=fake.pay(data.checkout.orderId);assert.equal((await webhook(fake.event("payment.captured",p))).status,200);
      assert.equal((await refresh(u,data)).body.data.order.canAccess,true);const enrollment=await Enrollment.findOne({student:u.id,course:publicCourse._id});assert.equal(enrollment.assignedBy,undefined);assert.deepEqual([...enrollment.publicPurchaseModes],[mode]);
      assert.equal(await Enrollment.countDocuments({student:u.id,course:publicCourse._id}),1);
      await Course.updateOne({_id:publicCourse._id},{$set:{visibility:"private"}});assert.equal((await refresh(u,data)).body.data.order.canAccess,true);await Course.updateOne({_id:publicCourse._id},{$set:{visibility:"public"}});
    });
    await t.test("private paid course can be bought without assignment and immediately unlocks learning", async () => {
      const u = await learner(false), lesson = await Lesson.findOne({ course: course._id });
      const assessment = await Assessment.create({ course: course._id, title: "Purchased mock test", kind: "mock", durationMinutes: 10, slot: 0, status: "published", questionCount: 1, questions: [{ prompt: "One plus one?", options: ["One", "Two"], correctIndex: 1 }] });
      const protectedPaths = [`/courses/${course._id}/notes`, `/courses/${course._id}/progress`, `/courses/${course._id}/assessments`];
      for (const path of protectedPaths) assert.equal((await call(path, u)).status, 403);
      assert.equal((await call(`/assessments/${assessment._id}/attempts`, u, "POST", {})).status, 403);
      const before = await call(`/courses/${course._id}`, u); assert.equal(before.body.data.access.videos, false); assert.ok(!JSON.stringify(before.body).includes(lesson.content));
      const detail = await call(`/public/courses/${course.slug}`); assert.deepEqual(detail.body.data.course.availability, { enrollment: "purchase", ready: true });
      assert.equal((await call(`/payments/courses/${course._id}/quote`, u)).body.data.quote.enrollmentType, "purchase");
      const data = await ready(u); assert.equal(data.order.enrollmentType, "purchase");
      const authorized = fake.pay(data.checkout.orderId, "authorized"); assert.equal((await verify(u, data, authorized)).body.data.order.canAccess, false);
      assert.equal(await Enrollment.countDocuments({ student: u.id, course: course._id }), 0);
      const p = fake.pay(data.checkout.orderId); assert.equal((await verify(u, data, p)).body.data.order.canAccess, true);
      const enrolled = await Enrollment.findOne({ student: u.id, course: course._id }); assert.equal(enrolled.assignedBy, undefined); assert.deepEqual([...enrolled.publicPurchaseModes], [mode]);
      for (const path of protectedPaths) assert.equal((await call(path, u)).status, 200);
      const unlocked = await call(`/courses/${course._id}`, u); assert.equal(unlocked.body.data.access.assigned, false); assert.equal(unlocked.body.data.access.videos, true); assert.ok(JSON.stringify(unlocked.body).includes(lesson.content));
      const attempt = await call(`/assessments/${assessment._id}/attempts`, u, "POST", {}); assert.equal(attempt.status, 200, JSON.stringify(attempt.body));
      assert.equal((await call(`/lessons/${lesson._id}/complete`, u, "POST", {})).status, 200);
      const mine = (await call("/enrollments/me", u)).body.data.enrollments; assert.equal(mine.length, 1); assert.equal(mine[0].course.payment.paid, true); assert.equal(mine[0].status, "completed");
      const card = (await call("/courses", u)).body.data.courses.find(c => String(c._id) === String(course._id)); assert.deepEqual(card.access, { assigned: false, enrolled: true, videos: true, status: "completed" });
      // Removing an old instructor assignment must not revoke a purchase.
      await Enrollment.updateOne({ _id: enrolled._id }, { $set: { assignedBy: owner.id } });
      assert.equal((await call(`/courses/${course._id}/assignments/${u.id}`, owner, "DELETE")).status, 200);
      assert.equal((await call(`/courses/${course._id}`, u)).body.data.access.videos, true);
      // Repair a missing purchase marker without resetting completion.
      await Enrollment.updateOne({ _id: enrolled._id }, { $unset: { publicPurchaseModes: "" } });
      await call("/enrollments/me", u); assert.equal((await Enrollment.findById(enrolled._id)).status, "completed");
      // A lost enrollment also recovers from the saved paid order on a direct visit.
      await Enrollment.deleteOne({ _id: enrolled._id });
      assert.equal((await call(`/courses/${course._id}`, u)).body.data.access.videos, true);
      assert.equal(await Enrollment.countDocuments({ student: u.id, course: course._id }), 1);
      fake.refund(p.id, 12345); assert.equal((await webhook(fake.event("refund.processed", { payment_id: p.id }))).status, 200);
      for (const path of protectedPaths) assert.equal((await call(path, u)).status, 402);
      assert.equal((await call(`/assessments/${assessment._id}/attempts`, u, "POST", {})).status, 402);
    });
    await t.test("webhook alone enrolls private buyers; retries preserve one enrollment and publication gates access", async () => {
      const u = await learner(false), data = await ready(u), p = fake.pay(data.checkout.orderId), event = fake.event("order.paid", fake.orders.get(p.order_id)), id = crypto.randomUUID();
      assert.equal((await webhook(event, { id })).status, 200); assert.equal((await webhook(event, { id })).body.duplicate, true);
      assert.equal((await call("/enrollments/me", u)).body.data.enrollments.length, 1);
      assert.equal((await call(`/courses/${course._id}`, u)).body.data.access.videos, true);
      assert.equal(await Enrollment.countDocuments({ student: u.id, course: course._id }), 1);
      for (const changes of [{ isPublished: false }, { archivedAt: new Date() }]) {
        await Course.updateOne({ _id: course._id }, { $set: changes });
        assert.ok([403,410].includes((await checkout(await learner(false))).status));
        assert.equal((await refresh(u, data)).body.data.order.canAccess, false);
        assert.equal((await call("/enrollments/me", u)).body.data.enrollments.length, 0);
        await Course.updateOne({ _id: course._id }, { $set: { isPublished: true, archivedAt: null } });
      }
      assert.equal((await call(`/courses/${course._id}`, u)).body.data.access.videos, true);
    });
    await t.test("instructor publishes a ready paid course without assigning anyone", async () => {
      const c = await makeCourse("private"), u = await learner(false);
      await Course.updateOne({ _id: c._id }, { $set: { isPublished: false } });
      assert.equal((await checkout(u, { selected: c })).status, 403);
      assert.equal((await call(`/courses/${c._id}/publish`, owner, "PATCH", { published: true })).status, 200);
      assert.equal(await Enrollment.countDocuments({ course: c._id }), 0);
      assert.equal((await checkout(u, { selected: c })).status, 201);
      const quote = (await call(`/payments/courses/${c._id}/quote`, u)).body.data.quote; assert.equal(quote.enrollmentType, "purchase"); assert.equal(quote.enrolled, false);
    });
    await t.test("saved purchases restore the student library while other modes and refunded orders cannot enroll", async () => {
      const u = await learner(false), foreign = await learner(false), refunded = await learner(false);
      const saved = { course: course._id, instructor: owner.id, title: course.title, amountMinor: 12345, status: "paid", active: false };
      await Model.create({ ...saved, student: u.id, requestKey: "restore_paid" });
      await paymentOrderModel(testMode ? "live" : "test").create({ ...saved, student: foreign.id, requestKey: "restore_foreign" });
      await Model.create({ ...saved, student: refunded.id, requestKey: "restore_refunded", status: "refunded", refundedMinor: 12345 });
      assert.equal((await call("/enrollments/me", u)).body.data.enrollments.length, 1);
      assert.equal((await call(`/courses/${course._id}`, u)).body.data.access.videos, true);
      for (const student of [foreign, refunded]) {
        assert.equal((await call("/enrollments/me", student)).body.data.enrollments.length, 0);
        assert.equal((await call(`/courses/${course._id}`, student)).body.data.access.videos, false);
        assert.equal(await Enrollment.countDocuments({ student: student.id }), 0);
      }
    });
    await t.test("old paid records remain accessible; pending historical records block replacement charges; modes are isolated", async () => {
      const old=await learner(), pending=await learner(), other=await learner();
      const legacy={course:course._id,instructor:owner.id,title:course.title,amountMinor:12345,checkoutExpiresAt:new Date(Date.now()+3600000)};
      await Model.create({...legacy,student:old.id,requestKey:"legacy_paid",status:"paid",active:false});
      await Model.create({...legacy,student:pending.id,requestKey:"legacy_pending"});
      assert.equal((await call(`/courses/${course._id}`,old)).status,200);assert.equal((await call("/payments/orders",old)).body.data.orders[0].provider,"legacy");assert.equal((await checkout(pending)).status,409);
      const Other=paymentOrderModel(testMode?"live":"test");await Other.create({...legacy,student:other.id,requestKey:"foreign_paid",status:"paid",active:false});assert.equal((await call(`/courses/${course._id}`,other)).status,402);assert.equal((await call("/payments/orders",other)).body.data.total,0);
    });
    await t.test("free public enrollment works without any payment keys and paid access still follows publication/account", async () => {
      const free=await makeCourse("public");await Course.updateOne({_id:free._id},{$set:{price:0}});const u=await learner(false),saved={...process.env};
      delete process.env.RAZORPAY_KEY_ID;delete process.env.RAZORPAY_KEY_SECRET;delete process.env.RAZORPAY_WEBHOOK_SECRET;
      try {const quote=await call(`/payments/courses/${free._id}/quote`,u);assert.equal(quote.body.data.quote.requiresPayment,false);assert.equal(quote.body.data.readiness.configured,false);assert.equal((await call(`/courses/${free._id}/enroll`,u,"POST",{quotedAmountMinor:0})).status,200);}finally{for(const k of ["RAZORPAY_KEY_ID","RAZORPAY_KEY_SECRET","RAZORPAY_WEBHOOK_SECRET"])process.env[k]=saved[k];}
      const v=await learner(),data=await ready(v),p=fake.pay(data.checkout.orderId);await verify(v,data,p);
      await Course.updateOne({_id:course._id},{$set:{isPublished:false}});assert.equal((await refresh(v,data)).body.data.order.canAccess,false);await Course.updateOne({_id:course._id},{$set:{isPublished:true}});
      await User.updateOne({_id:v.id},{$set:{status:"suspended"}});assert.equal((await refresh(v,data)).status,401);
    });
  } finally {
    fake.beforeReturn=null;fake.unavailable=false;fake.rejectCreate=false;await new Promise(resolve=>server.close(resolve));delete app.locals.razorpayClient;
    assert.match(mongoose.connection.name,/^lms_test_payments_/);await mongoose.connection.dropDatabase();await mongoose.disconnect();
    for(const key of Object.keys(settings(mode)))delete process.env[key];
  }
});
