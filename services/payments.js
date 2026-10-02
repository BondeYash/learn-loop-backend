import crypto from "node:crypto";
import mongoose from "mongoose";
import { paymentOrderModel } from "../models/PaymentOrder.js";
import { stripeEventModel } from "../models/StripeEvent.js";
import User from "../models/User.js";
import ApiError from "../utils/ApiError.js";
import { requireCourseNomination } from "./courseAccess.js";
import { ensureCourseReady } from "./courseReadiness.js";
import { rupeesToMinor } from "./coursePricing.js";
import { requireStripeSettings, trustedCheckoutUrl, checkoutOrigin, assertStripeEventMode } from "./stripeClient.js";
import { stripeMode } from "./stripeMode.js";
import { reportPaymentFailure } from "./paymentDiagnostics.js";

const SESSION_FIELDS = "+stripeSessionId +stripePaymentIntentId +checkoutUrl";
const ref = (value) => typeof value === "string" ? value : value?.id;
export const paymentEvents = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired", "payment_intent.succeeded", "payment_intent.payment_failed", "payment_intent.canceled", "charge.refunded", "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed"]);

export function publicOrder(order) {
  return { id: String(order._id), courseId: String(order.course), title: order.title, amountMinor: order.amountMinor, currency: "inr", status: order.status, testMode: order.testMode, refundedMinor: order.refundedMinor, paidAt: order.paidAt, checkoutExpiresAt: order.checkoutExpiresAt };
}
export async function quoteCourse(courseId, user) {
  const mode = stripeMode(), testMode = mode === "test", PaymentOrder = paymentOrderModel(mode);
  const course = await requireCourseNomination(courseId, user);
  const existing = await PaymentOrder.findOne({ student: user._id, course: course._id, status: "paid", testMode });
  // Keep an expired-but-unreconciled attempt reachable so its owner can check
  // canonical Stripe status before opening a replacement checkout.
  const pending = await PaymentOrder.findOne({ student: user._id, course: course._id, active: true, testMode });
  return { courseId: String(course._id), title: course.title, amountMinor: pending?.amountMinor ?? rupeesToMinor(course.price), currency: "inr", testMode, paid: Boolean(existing), requiresPayment: course.price > 0 && !existing, ...(pending ? { pendingOrderId: String(pending._id) } : {}) };
}

export async function startCheckout(courseId, user, requestKey, quotedAmountMinor, stripe) {
  const { mode, testMode } = requireStripeSettings(), PaymentOrder = paymentOrderModel(mode);
  const origin = checkoutOrigin();
  if (typeof requestKey !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(requestKey)) throw new ApiError(400, "Send a stable Idempotency-Key (16–80 letters, digits, underscores or hyphens) when retrying checkout.");
  const course = await requireCourseNomination(courseId, user);
  await ensureCourseReady(course._id);
  const amountMinor = rupeesToMinor(course.price);
  if (!amountMinor) throw new ApiError(409, "This course is free; no payment is needed.");
  if (await PaymentOrder.exists({ student: user._id, course: course._id, status: "paid", testMode })) throw new ApiError(409, "This course is already paid for.");
  // Keep the established test hash stable so pre-release retries still work.
  const hash = crypto.createHash("sha256").update(`${testMode ? "" : "live:"}${user._id}:${requestKey}`).digest("hex");
  let order = await PaymentOrder.findOne({ student: user._id, requestKey: hash, testMode }).select(SESSION_FIELDS);
  if (order && String(order.course) !== String(course._id)) throw new ApiError(409, "This checkout key belongs to another course.");
  if (!order) order = await PaymentOrder.findOne({ student: user._id, course: course._id, active: true, testMode }).select(SESSION_FIELDS);
  if (!order) {
    if (quotedAmountMinor !== amountMinor) throw new ApiError(409, "The course price changed. Refresh the price before paying.");
    try {
      order = await PaymentOrder.findOneAndUpdate({ student: user._id, requestKey: hash, testMode }, { $setOnInsert: { course: course._id, instructor: course.instructor, title: course.title, amountMinor, currency: "inr", checkoutExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } }, { upsert: true, new: true, runValidators: true }).select(SESSION_FIELDS);
    } catch (error) {
      if (error.code !== 11000) throw error;
      order = await PaymentOrder.findOne({ student: user._id, course: course._id, active: true, testMode }).select(SESSION_FIELDS);
    }
  }
  if (!order || String(order.course) !== String(course._id)) throw new ApiError(409, "This checkout attempt belongs to another course.");
  if (quotedAmountMinor !== order.amountMinor) throw new ApiError(409, "An existing checkout uses an earlier course price. Refresh its payment status before continuing.");
  if (order.stripeSessionId && order.checkoutExpiresAt < new Date()) throw new ApiError(409, "This checkout attempt expired. Start a new attempt.");
  if (["paid", "refunded", "partially_refunded", "disputed", "reversed"].includes(order.status)) throw new ApiError(409, "This payment has finished or needs review. Refresh its status before starting another.");
  if (order.checkoutUrl) return { order: publicOrder(order), url: order.checkoutUrl };
  const metadata = { orderId: String(order._id), studentId: String(order.student), courseId: String(order.course) };
  let session;
  try {
    // Let Stripe select eligible methods from this account's Dashboard settings.
    // Do not force a static list or accept method overrides from the browser.
    session = await stripe.checkout.sessions.create({ mode: "payment", client_reference_id: String(order._id), metadata, payment_intent_data: { metadata }, line_items: [{ quantity: 1, price_data: { currency: "inr", unit_amount: order.amountMinor, product_data: { name: order.title } } }], success_url: `${origin.origin}/payments/${order._id}?checkout=success`, cancel_url: `${origin.origin}/payments/${order._id}?checkout=canceled` }, { idempotencyKey: `lessonloop-${mode}-checkout-${order._id}` });
  } catch (error) {
    reportPaymentFailure(error, "checkout_create", mode);
    throw new ApiError(502, "Stripe checkout is temporarily unavailable. Retry this same payment attempt.");
  }
  if (session.livemode !== !testMode || !trustedCheckoutUrl(session.url) || !session.id?.startsWith(`cs_${mode}_`) || !Number.isSafeInteger(session.expires_at) || session.expires_at <= Math.floor(Date.now() / 1000)) throw new ApiError(502, "Stripe did not return a valid checkout session for this mode.");
  const saved = await PaymentOrder.findOneAndUpdate({ _id: order._id, $or: [{ stripeSessionId: { $exists: false } }, { stripeSessionId: session.id }] }, { $set: { stripeSessionId: session.id, checkoutUrl: session.url, checkoutExpiresAt: new Date(session.expires_at * 1000) } }, { new: true }).select(SESSION_FIELDS);
  if (!saved) throw new ApiError(409, "The payment attempt changed. Refresh before paying.");
  try {
    const current = await requireCourseNomination(course._id, user);
    if (!current.price || !await User.exists({ _id: user._id, status: "active", mustChangePassword: false, authVersion: user.authVersion || 0 })) throw new ApiError(409, "Course or account access changed while opening checkout.");
  } catch (error) {
    // If access changes while Stripe is opening the page, retire an unpaid
    // session before returning a redirect. A completed charge remains recorded.
    try {
      const expired = await stripe.checkout.sessions.expire(session.id);
      if (expired.livemode === !testMode && expired.status === "expired") await PaymentOrder.updateOne({ _id: order._id, status: { $in: ["pending", "failed"] } }, { $set: { status: "expired", active: false } });
    } catch { /* Preserve the order for signed webhook/reconciliation recovery. */ }
    throw error;
  }
  return { order: publicOrder(saved), url: session.url };
}

function assertSession(order, session) {
  const metadata = session.metadata || {};
  const mode = order.testMode ? "test" : "live";
  if (session.livemode !== !order.testMode || !session.id?.startsWith(`cs_${mode}_`) || session.mode !== "payment" || session.currency !== "inr" || session.amount_total !== order.amountMinor || session.client_reference_id !== String(order._id) || metadata.orderId !== String(order._id) || metadata.studentId !== String(order.student) || metadata.courseId !== String(order.course) || (order.stripeSessionId && order.stripeSessionId !== session.id)) throw new ApiError(409, "Stripe payment details do not match this order.");
}
export async function reconcileOrder(orderId, sessionId, stripe, eventCreated) {
  const { mode, testMode } = requireStripeSettings(), PaymentOrder = paymentOrderModel(mode);
  const token = crypto.randomUUID(), now = new Date();
  const order = await PaymentOrder.findOneAndUpdate({ _id: orderId, testMode, $or: [{ reconciliationLeaseUntil: { $exists: false } }, { reconciliationLeaseUntil: { $lt: now } }] }, { $set: { reconciliationToken: token, reconciliationLeaseUntil: new Date(Date.now() + 90000) } }, { new: true }).select(SESSION_FIELDS);
  if (!order) throw new ApiError(503, "Payment status is being checked. Retry shortly.");
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId || order.stripeSessionId);
    assertSession(order, session);
    let status = session.status === "expired" ? "expired" : "pending", refundedMinor = 0, paymentIntentId = ref(session.payment_intent);
    if (paymentIntentId) {
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
      const meta = intent.metadata || {};
      if (intent.livemode !== !testMode || intent.id !== paymentIntentId || (order.stripePaymentIntentId && order.stripePaymentIntentId !== intent.id) || intent.amount !== order.amountMinor || intent.currency !== "inr" || meta.orderId !== String(order._id) || meta.studentId !== String(order.student) || meta.courseId !== String(order.course)) throw new ApiError(409, "Stripe payment intent does not match this order.");
      const charge = intent.latest_charge;
      if (charge && (typeof charge !== "object" || charge.livemode !== !testMode || charge.amount !== order.amountMinor || charge.currency !== "inr" || ref(charge.payment_intent) !== intent.id)) throw new ApiError(409, "Stripe charge does not match this order.");
      if (session.payment_status === "paid" && intent.status === "succeeded" && charge?.paid === true && charge.status === "succeeded") status = "paid";
      else if (intent.status === "canceled" || intent.last_payment_error) status = "failed";
      refundedMinor = Number(charge?.amount_refunded || 0);
      if (!Number.isSafeInteger(refundedMinor) || refundedMinor < 0 || refundedMinor > order.amountMinor) throw new ApiError(409, "Stripe refund amount does not match this order.");
      if (refundedMinor > 0) status = refundedMinor >= order.amountMinor ? "refunded" : "partially_refunded";
      if (charge?.disputed) {
        const disputes = await stripe.disputes.list({ charge: charge.id, limit: 10 });
        if (!disputes.data?.length) throw new ApiError(503, "Stripe dispute details are not available yet.");
        if (disputes.data.some((dispute) => dispute.livemode !== !testMode || ref(dispute.charge) !== charge.id || ref(dispute.payment_intent) !== intent.id)) throw new ApiError(409, "Stripe dispute does not match this order.");
        if (disputes.data.some((dispute) => dispute.status === "lost")) status = "reversed";
        else if (disputes.data.some((dispute) => dispute.status !== "won")) status = "disputed";
      }
    }
    const update = { status, active: ["pending", "failed"].includes(status), refundedMinor, stripeSessionId: session.id, ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}), ...(status === "paid" && !order.paidAt ? { paidAt: new Date() } : {}), ...(eventCreated ? { lastStripeEventAt: new Date(eventCreated * 1000) } : {}) };
    const saved = await PaymentOrder.findOneAndUpdate({ _id: order._id, reconciliationToken: token }, { $set: update }, { new: true });
    if (!saved) throw new ApiError(503, "Payment status changed. Retry shortly.");
    // Access checks also require a current active assignment and published,
    // unarchived course. Never create assignments or reset learning progress here.
    return saved;
  } finally {
    await PaymentOrder.updateOne({ _id: order._id, reconciliationToken: token }, { $unset: { reconciliationToken: 1, reconciliationLeaseUntil: 1 } });
  }
}

export async function handlePaymentEvent(event, stripe) {
  const { mode, testMode } = requireStripeSettings(), PaymentOrder = paymentOrderModel(mode), StripeEvent = stripeEventModel(mode);
  assertStripeEventMode(event);
  if (!paymentEvents.has(event.type)) return { ignored: true };
  if (!/^evt_[A-Za-z0-9_]+$/.test(event.id) || !Number.isSafeInteger(event.created)) throw new ApiError(400, "Invalid Stripe event.");
  const token = crypto.randomUUID();
  try { await StripeEvent.create({ _id: event.id, type: event.type, token, leaseUntil: new Date(Date.now() + 90000) }); }
  catch (error) {
    if (error.code !== 11000) throw error;
    const previous = await StripeEvent.findById(event.id);
    if (previous.status === "processed") return { duplicate: true };
    const claimed = await StripeEvent.updateOne({ _id: event.id, status: "processing", leaseUntil: { $lt: new Date() } }, { $set: { token, leaseUntil: new Date(Date.now() + 90000) } });
    if (!claimed.modifiedCount) throw new ApiError(503, "Stripe event is being processed. Retry shortly.");
  }
  try {
    const object = event.data.object;
    let orderId = object.metadata?.orderId, sessionId;
    if (event.type.startsWith("checkout.session.")) sessionId = object.id;
    let order;
    if (orderId && mongoose.isValidObjectId(orderId)) order = await PaymentOrder.findById(orderId).select(SESSION_FIELDS);
    if (!order && sessionId) order = await PaymentOrder.findOne({ stripeSessionId: sessionId }).select(SESSION_FIELDS);
    if (!order) {
      let intentId = event.type.startsWith("payment_intent.") ? object.id : ref(object.payment_intent);
      if (!intentId && event.type.startsWith("charge.dispute.") && ref(object.charge)) {
        const charge = await stripe.charges.retrieve(ref(object.charge));
        intentId = ref(charge.payment_intent);
      }
      if (intentId) {
        order = await PaymentOrder.findOne({ stripePaymentIntentId: intentId }).select(SESSION_FIELDS);
        if (!order) {
          const intent = await stripe.paymentIntents.retrieve(intentId);
          orderId = intent.metadata?.orderId;
          if (mongoose.isValidObjectId(orderId)) order = await PaymentOrder.findById(orderId).select(SESSION_FIELDS);
        }
      }
    }
    if (order) {
      if (!sessionId && !order.stripeSessionId) throw new ApiError(503, "Checkout session is not attached yet. Retry shortly.");
      await reconcileOrder(order._id, sessionId, stripe, event.created);
    }
    await StripeEvent.updateOne({ _id: event.id, token }, { $set: { status: "processed", processedAt: new Date() }, $unset: { token: 1, leaseUntil: 1 } });
    return { received: true, ignored: !order };
  } catch (error) {
    await StripeEvent.updateOne({ _id: event.id, token }, { $set: { leaseUntil: new Date(0) } });
    throw error;
  }
}
