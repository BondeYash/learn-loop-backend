import crypto from "node:crypto";
import mongoose from "mongoose";
import User from "../models/User.js";
import { paymentOrderModel } from "../models/PaymentOrder.js";
import { razorpayEventModel } from "../models/RazorpayEvent.js";
import ApiError from "../utils/ApiError.js";
import { courseEnrollment, requireCheckoutEligibility } from "./courseAccess.js";
import { fulfillPublicPurchase } from "./publicEnrollment.js";
import { ensureCourseReady } from "./courseReadiness.js";
import { rupeesToMinor } from "./coursePricing.js";
import { paymentMode } from "./paymentSettings.js";
import { requireRazorpaySettings, validRazorpayId, validSignature } from "./razorpayClient.js";

export const ORDER_FIELDS = "+razorpayOrderId +razorpayPaymentId +checkoutContract +creationToken";
export const paymentEvents = new Set(["payment.captured", "order.paid", "payment.failed", "refund.processed"]);
const providerOf = (order) => order.provider === "razorpay" ? "razorpay" : "legacy";
export function publicOrder(order) {
  return { id: String(order._id), courseId: String(order.course), title: order.title, provider: providerOf(order), amountMinor: order.amountMinor, currency: "inr", status: order.status, testMode: order.testMode, refundedMinor: order.refundedMinor, paidAt: order.paidAt, checkoutExpiresAt: order.checkoutExpiresAt, createdAt: order.createdAt, enrollmentType: order.publicEnrollmentRequestedAt ? "public" : order.enrollmentType || "assigned" };
}
export async function quoteCourse(courseId, user) {
  const course = await requireCheckoutEligibility(courseId, user);
  const mode = paymentMode(), testMode = mode === "test", PaymentOrder = paymentOrderModel(mode);
  const [enrollment, paid, pending] = await Promise.all([
    courseEnrollment(course, user),
    PaymentOrder.exists({ student: user._id, course: course._id, status: "paid", testMode }),
    PaymentOrder.findOne({ student: user._id, course: course._id, active: true, testMode }),
  ]);
  return { courseId: String(course._id), title: course.title, provider: "razorpay", amountMinor: course.price ? pending?.amountMinor ?? rupeesToMinor(course.price) : 0, currentAmountMinor: rupeesToMinor(course.price), currency: "inr", testMode, paid: Boolean(paid), requiresPayment: course.price > 0 && !paid, enrolled: Boolean(enrollment), enrollmentRequired: !enrollment, enrollmentType: course.visibility === "public" ? "public" : "assigned", ...(course.price && pending ? { pendingOrderId: String(pending._id) } : {}) };
}
function orderRequest(order) {
  return { amount: order.amountMinor, currency: "INR", receipt: `ll_${order.testMode ? "test" : "live"}_${order._id}`, partial_payment: false, notes: { orderId: String(order._id), courseId: String(order.course), studentId: String(order.student), mode: order.testMode ? "test" : "live" } };
}
function assertOrder(order, remote) {
  const expected = orderRequest(order);
  if (!validRazorpayId(remote?.id, "order") || remote.entity !== "order" || remote.amount !== expected.amount || remote.currency !== "INR" || remote.receipt !== expected.receipt || !["created", "attempted", "paid"].includes(remote.status) || (order.razorpayOrderId && remote.id !== order.razorpayOrderId) || Object.entries(expected.notes).some(([key, value]) => remote.notes?.[key] !== value)) throw new ApiError(409, "Razorpay order details do not match this course purchase.");
  if (!Number.isSafeInteger(remote.amount_paid) || !Number.isSafeInteger(remote.amount_due) || remote.amount_paid < 0 || remote.amount_due < 0 || remote.amount_paid + remote.amount_due !== order.amountMinor) throw new ApiError(409, "Razorpay order amounts do not match this purchase.");
}
function collection(data) {
  if (data?.entity !== "collection" || !Array.isArray(data.items) || data.items.length > 100 || data.count !== data.items.length) throw new ApiError(503, "Razorpay payment details are incomplete. Retry shortly.");
  return data.items;
}
async function attachOrder(order, remote) {
  assertOrder(order, remote);
  const saved = await paymentOrderModel(order.testMode ? "test" : "live").findOneAndUpdate({ _id: order._id, provider: "razorpay", $or: [{ razorpayOrderId: { $exists: false } }, { razorpayOrderId: remote.id }] }, { $set: { razorpayOrderId: remote.id } }, { new: true }).select(ORDER_FIELDS);
  if (!saved) throw new ApiError(409, "The payment attempt changed. Refresh its status.");
  return saved;
}
async function recoverCreatedOrder(order, client) {
  if (order.checkoutContract?.keyId !== process.env.RAZORPAY_KEY_ID) throw new ApiError(409, "This unfinished payment uses earlier credentials and needs administrator review.");
  const matches = [], started = Date.now();
  for (let page = 0; page < 5; page++) {
    if (Date.now() - started > 10000) throw new ApiError(503, "Payment recovery is taking longer than expected. Retry shortly.");
    const items = collection(await client.fetchOrders({ receipt: orderRequest(order).receipt, count: 100, skip: page * 100 }));
    for (const remote of items) if (remote.receipt === orderRequest(order).receipt) matches.push(remote);
    if (matches.length > 1) throw new ApiError(409, "Multiple payment orders need administrator review. No new checkout was created.");
    if (items.length < 100) return matches.length ? attachOrder(order, matches[0]) : null;
  }
  throw new ApiError(503, "Payment recovery exceeds the safe scan limit. No new checkout was created.");
}
async function ensureProviderOrder(order, client) {
  if (order.razorpayOrderId) return order;
  const Model = paymentOrderModel(order.testMode ? "test" : "live"), token = crypto.randomUUID();
  const claimed = await Model.findOneAndUpdate({ _id: order._id, provider: "razorpay", razorpayOrderId: { $exists: false }, $or: [{ creationLeaseUntil: { $exists: false } }, { creationLeaseUntil: { $lt: new Date() } }] }, { $set: { creationToken: token, creationLeaseUntil: new Date(Date.now() + 30000) } }, { new: true }).select(ORDER_FIELDS);
  if (!claimed) {
    const saved = await Model.findById(order._id).select(ORDER_FIELDS);
    if (saved?.razorpayOrderId) return saved;
    throw new ApiError(503, "Checkout is being prepared. Retry the same payment attempt shortly.");
  }
  try {
    if (claimed.creationStartedAt) {
      const recovered = await recoverCreatedOrder(claimed, client);
      if (!recovered) throw new ApiError(503, "The earlier checkout outcome is not confirmed yet. Retry this same attempt; no replacement order was created.");
      return recovered;
    }
    if (claimed.checkoutContract?.version !== 1 || claimed.checkoutContract.keyId !== process.env.RAZORPAY_KEY_ID || JSON.stringify(claimed.checkoutContract.request) !== JSON.stringify(orderRequest(claimed))) throw new ApiError(409, "The saved checkout configuration needs administrator review.");
    // Persist before the provider call. An interrupted response is recovered by
    // its exact receipt; an uncertain POST is never repeated automatically.
    await Model.updateOne({ _id: claimed._id, creationToken: token }, { $set: { creationStartedAt: new Date() } });
    let remote;
    try { remote = await client.createOrder(structuredClone(claimed.checkoutContract.request)); }
    catch (error) {
      if (error.providerRejected) await Model.updateOne({ _id: claimed._id, creationToken: token }, { $set: { status: "failed", active: false } });
      throw error;
    }
    return await attachOrder(claimed, remote);
  } finally {
    await Model.updateOne({ _id: claimed._id, creationToken: token }, { $unset: { creationToken: 1, creationLeaseUntil: 1 } });
  }
}
export async function startCheckout(courseId, user, requestKey, quotedAmountMinor, client) {
  const { mode, testMode } = requireRazorpaySettings(), Model = paymentOrderModel(mode);
  if (typeof requestKey !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(requestKey)) throw new ApiError(400, "Use a stable payment request identifier when retrying checkout.");
  const course = await requireCheckoutEligibility(courseId, user);
  await ensureCourseReady(course._id);
  const amountMinor = rupeesToMinor(course.price);
  if (amountMinor < 100) throw new ApiError(400, "A paid Razorpay course must cost at least INR 1.00. Free courses use free enrollment.");
  if (await Model.exists({ student: user._id, course: course._id, status: "paid", testMode })) throw new ApiError(409, "This course is already paid for. Refresh to open it.");
  const hash = crypto.createHash("sha256").update(`razorpay:${mode}:${user._id}:${requestKey}`).digest("hex");
  let order = await Model.findOne({ student: user._id, requestKey: hash, testMode }).select(ORDER_FIELDS);
  if (order && String(order.course) !== String(course._id)) throw new ApiError(409, "This payment request belongs to another course.");
  if (!order) order = await Model.findOne({ student: user._id, course: course._id, active: true, testMode }).select(ORDER_FIELDS);
  if (!order) {
    if (quotedAmountMinor !== amountMinor) throw new ApiError(409, "The course price changed. Refresh before paying.");
    const initial = { _id: new mongoose.Types.ObjectId(), provider: "razorpay", student: user._id, course: course._id, instructor: course.instructor, title: course.title, amountMinor, currency: "inr", testMode, enrollmentType: course.visibility === "public" ? "public" : "assigned" };
    initial.checkoutContract = { version: 1, keyId: process.env.RAZORPAY_KEY_ID, request: orderRequest(initial) };
    try { order = await Model.findOneAndUpdate({ student: user._id, requestKey: hash, testMode }, { $setOnInsert: initial }, { upsert: true, new: true, runValidators: true }).select(ORDER_FIELDS); }
    catch (error) {
      if (error.code !== 11000) throw error;
      order = await Model.findOne({ student: user._id, course: course._id, active: true, testMode }).select(ORDER_FIELDS);
    }
  }
  if (!order || providerOf(order) !== "razorpay") throw new ApiError(409, "An earlier payment record needs administrator review before a new checkout can open.");
  if (String(order.course) !== String(course._id) || quotedAmountMinor !== order.amountMinor) throw new ApiError(409, "An earlier payment uses different course details. Review its status before paying.");
  if (order.status !== "pending") throw new ApiError(409, "This payment attempt finished. Refresh the status before starting another attempt.");
  if (course.visibility === "public" && !order.publicEnrollmentRequestedAt) order = await Model.findByIdAndUpdate(order._id, { $set: { publicEnrollmentRequestedAt: new Date() } }, { new: true }).select(ORDER_FIELDS);
  order = await ensureProviderOrder(order, client);
  order = await reconcileOrder(order._id, client);
  if (order.status !== "pending") throw new ApiError(409, "This payment attempt finished. Refresh to see its current status.");
  await requireCheckoutEligibility(course._id, user);
  if (!await User.exists({ _id: user._id, status: "active", mustChangePassword: false, authVersion: user.authVersion || 0 })) throw new ApiError(409, "Your account changed while opening checkout. Sign in again.");
  return { order: publicOrder(order), checkout: { provider: "razorpay", keyId: process.env.RAZORPAY_KEY_ID, orderId: order.razorpayOrderId, amount: order.amountMinor, currency: "INR", name: "Praneet Vidyapeeth", description: order.title, prefill: { name: user.name, email: user.email } } };
}
export async function reconcileOrder(orderId, client) {
  const { mode, testMode } = requireRazorpaySettings(), Model = paymentOrderModel(mode), token = crypto.randomUUID();
  let order = await Model.findOneAndUpdate({ _id: orderId, provider: "razorpay", testMode, $or: [{ reconciliationLeaseUntil: { $exists: false } }, { reconciliationLeaseUntil: { $lt: new Date() } }] }, { $set: { reconciliationToken: token, reconciliationLeaseUntil: new Date(Date.now() + 15000) } }, { new: true }).select(ORDER_FIELDS);
  if (!order) throw new ApiError(503, "Payment status is being checked. Retry shortly.");
  try {
    if (!order.razorpayOrderId) {
      order = await ensureProviderOrder(order, client);
    }
    const [remote, response] = await Promise.all([client.fetchOrder(order.razorpayOrderId), client.fetchOrderPayments(order.razorpayOrderId)]);
    assertOrder(order, remote);
    const payments = collection(response);
    for (const payment of payments) {
      if (!validRazorpayId(payment.id, "pay") || payment.entity !== "payment" || payment.order_id !== remote.id || payment.amount !== order.amountMinor || payment.currency !== "INR" || !["created", "authorized", "captured", "failed", "refunded"].includes(payment.status)) throw new ApiError(409, "Razorpay payment details do not match this course purchase.");
    }
    const captured = payments.filter((p) => ["captured", "refunded"].includes(p.status) && p.captured === true);
    if (captured.length > 1) throw new ApiError(409, "Multiple captured payments need administrator review.");
    let status = payments.length && payments.every((p) => p.status === "failed") ? "failed" : "pending", refundedMinor = 0;
    const payment = captured[0];
    if (payment) {
      if (remote.status !== "paid" || remote.amount_paid !== order.amountMinor || remote.amount_due !== 0) throw new ApiError(503, "Payment capture is awaiting confirmation. Retry shortly.");
      refundedMinor = payment.amount_refunded ?? 0;
      if (!Number.isSafeInteger(refundedMinor) || refundedMinor < 0 || refundedMinor > order.amountMinor) throw new ApiError(409, "Razorpay refund amount does not match this purchase.");
      status = refundedMinor === order.amountMinor ? "refunded" : refundedMinor > 0 ? "partially_refunded" : "paid";
    } else if (remote.status === "paid") throw new ApiError(503, "Captured payment details are not available yet. Retry shortly.");
    // A previously confirmed charge must not regress to pending on a stale read.
    if (!payment && ["paid", "partially_refunded", "refunded", "disputed", "reversed"].includes(order.status)) throw new ApiError(503, "Payment details are temporarily incomplete. Retry shortly.");
    if (refundedMinor < (order.refundedMinor || 0)) throw new ApiError(503, "Refund details are temporarily incomplete. Retry shortly.");
    const saved = await Model.findOneAndUpdate({ _id: order._id, reconciliationToken: token }, { $set: { status, active: status === "pending", refundedMinor, ...(payment ? { razorpayPaymentId: payment.id } : {}), ...(status === "paid" && !order.paidAt ? { paidAt: new Date() } : {}) } }, { new: true }).select(ORDER_FIELDS);
    if (!saved) throw new ApiError(503, "Payment status changed. Retry shortly.");
    await fulfillPublicPurchase(saved);
    return saved;
  } finally {
    await Model.updateOne({ _id: order._id, reconciliationToken: token }, { $unset: { reconciliationToken: 1, reconciliationLeaseUntil: 1 } });
  }
}
export async function verifyCheckout(order, body, client) {
  requireRazorpaySettings();
  if (providerOf(order) !== "razorpay" || !order.razorpayOrderId || body.razorpay_order_id !== order.razorpayOrderId || !validRazorpayId(body.razorpay_payment_id, "pay") || !validSignature(`${order.razorpayOrderId}|${body.razorpay_payment_id}`, body.razorpay_signature, process.env.RAZORPAY_KEY_SECRET)) throw new ApiError(400, "Invalid Razorpay checkout signature.");
  const payment = await client.fetchPayment(body.razorpay_payment_id);
  if (payment.order_id !== order.razorpayOrderId || payment.id !== body.razorpay_payment_id || payment.amount !== order.amountMinor || payment.currency !== "INR") throw new ApiError(409, "This payment does not belong to your course purchase.");
  return reconcileOrder(order._id, client);
}
export async function handlePaymentEvent(event, eventId, client) {
  const { mode, testMode } = requireRazorpaySettings(), Model = paymentOrderModel(mode), Events = razorpayEventModel(mode);
  if (!paymentEvents.has(event.event)) return { ignored: true };
  if (typeof eventId !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(eventId)) throw new ApiError(400, "Invalid webhook event identifier.");
  const token = crypto.randomUUID();
  try { await Events.create({ _id: eventId, type: event.event, token, leaseUntil: new Date(Date.now() + 15000) }); }
  catch (error) {
    if (error.code !== 11000) throw error;
    const previous = await Events.findById(eventId);
    if (previous.status === "processed") return { duplicate: true };
    if (!(await Events.updateOne({ _id: eventId, leaseUntil: { $lt: new Date() } }, { $set: { token, leaseUntil: new Date(Date.now() + 15000) } })).modifiedCount) throw new ApiError(503, "The webhook is being processed. Retry shortly.");
  }
  try {
    const hintedOrder = event.payload?.order?.entity, hintedPayment = event.payload?.payment?.entity, refund = event.payload?.refund?.entity;
    let remoteId = hintedOrder?.id || hintedPayment?.order_id;
    // A stored capture lets refund delivery use the same two parallel provider
    // reads as capture delivery, keeping acknowledgements within five seconds.
    if (!remoteId && validRazorpayId(refund?.payment_id, "pay")) {
      const known = await Model.findOne({ razorpayPaymentId: refund.payment_id, provider: "razorpay", testMode }).select(ORDER_FIELDS);
      remoteId = known?.razorpayOrderId || (await client.fetchPayment(refund.payment_id)).order_id;
    }
    if (!validRazorpayId(remoteId, "order")) throw new ApiError(400, "The webhook is missing a valid payment order.");
    let order = await Model.findOne({ razorpayOrderId: remoteId, provider: "razorpay", testMode }).select(ORDER_FIELDS);
    if (!order) {
      const remote = await client.fetchOrder(remoteId), localId = remote.notes?.orderId;
      if (mongoose.isValidObjectId(localId)) order = await Model.findOne({ _id: localId, provider: "razorpay", testMode }).select(ORDER_FIELDS);
      if (order) order = await attachOrder(order, remote);
    }
    if (order) await reconcileOrder(order._id, client);
    await Events.updateOne({ _id: eventId, token }, { $set: { status: "processed", processedAt: new Date() }, $unset: { token: 1, leaseUntil: 1 } });
    return { received: true, ignored: !order };
  } catch (error) {
    await Events.updateOne({ _id: eventId, token }, { $set: { leaseUntil: new Date(0) } });
    throw error;
  }
}
