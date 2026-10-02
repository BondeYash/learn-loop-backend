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
import { reportPaymentFailure, checkoutFailureMessage } from "./paymentDiagnostics.js";

const SESSION_FIELDS = "+stripeSessionId +stripePaymentIntentId +checkoutUrl +checkoutContract +checkoutRecoveryPlan";
const ref = (value) => typeof value === "string" ? value : value?.id;
export const paymentEvents = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired", "payment_intent.succeeded", "payment_intent.payment_failed", "payment_intent.canceled", "charge.refunded", "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed"]);

function checkoutRequest(order, origin) {
  const metadata = { orderId: String(order._id), studentId: String(order.student), courseId: String(order.course) };
  return { mode: "payment", client_reference_id: String(order._id), metadata, payment_intent_data: { metadata }, line_items: [{ quantity: 1, price_data: { currency: "inr", unit_amount: order.amountMinor, product_data: { name: order.title } } }], success_url: `${origin.origin}/payments/${order._id}?checkout=success`, cancel_url: `${origin.origin}/payments/${order._id}?checkout=canceled` };
}
function newCheckoutContract(order, origin) {
  return { version: 2, createdAt: new Date().toISOString(), key: `lessonloop-${order.testMode ? "test" : "live"}-checkout-v2-${order._id}`, request: checkoutRequest(order, origin) };
}
function assertCheckoutContract(order, contract, origin) {
  if (contract?.version !== 2 || contract.key !== `lessonloop-${order.testMode ? "test" : "live"}-checkout-v2-${order._id}` || JSON.stringify(contract.request) !== JSON.stringify(checkoutRequest(order, origin))) throw new ApiError(503, "This payment attempt's saved configuration needs review. No new checkout was opened.");
}

async function legacySession(order, stripe) {
  const matches = [], started = Date.now(); let cursor;
  try {
    for (let page = 0; page < 5; page++) {
      const result = await stripe.checkout.sessions.list({ limit: 100, created: { gte: Math.floor(order.createdAt.getTime() / 1000) - 120 }, ...(cursor ? { starting_after: cursor } : {}) });
      if (Date.now() - started > 10000 || !Array.isArray(result.data) || typeof result.has_more !== "boolean") throw new ApiError(503, "Earlier checkout reconciliation is incomplete. Retry shortly.");
      for (const session of result.data) if (session.metadata?.orderId === String(order._id) || session.client_reference_id === String(order._id)) { assertSession(order, session); matches.push(session); }
      if (!result.has_more) {
        if (matches.length > 1) throw new ApiError(409, "Multiple earlier checkout sessions need review. No replacement was opened.");
        if (!matches.length) return null;
        const session = await stripe.checkout.sessions.retrieve(matches[0].id); assertSession(order, session); return session;
      }
      const last = result.data.at(-1)?.id;
      if (!last || last === cursor) throw new ApiError(503, "Earlier checkout reconciliation is incomplete. Retry shortly.");
      cursor = last;
    }
    throw new ApiError(503, "Earlier checkout reconciliation exceeds the safe scan limit. No replacement was opened.");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    reportPaymentFailure(error, "checkout_reconcile", order.testMode ? "test" : "live");
    throw new ApiError(503, "Earlier checkout status is unavailable. No replacement was opened.");
  }
}

async function recoverLegacyCheckout(order, stripe, origin, PaymentOrder) {
  let session = await legacySession(order, stripe);
  if (session) return { order, session };
  if (Date.now() - order.createdAt.getTime() >= 24 * 60 * 60 * 1000) throw new ApiError(409, "The earlier payment's retry window ended. Its outcome needs review; no replacement was opened.");
  if (!order.checkoutRecoveryPlan) {
    const request = checkoutRequest(order, origin), key = `lessonloop-${order.testMode ? "test" : "live"}-checkout-${order._id}`;
    const plan = { current: { key, request }, original: { key, request: { ...request, payment_method_types: ["card"], expires_at: Math.floor(order.checkoutExpiresAt.getTime() / 1000) } }, replacement: newCheckoutContract(order, origin) };
    // This compare-and-set is the only controlled addition of an immutable
    // recovery snapshot to an older document. Concurrent callers load one plan.
    await PaymentOrder.collection.updateOne({ _id: order._id, checkoutRecoveryPlan: { $exists: false } }, { $set: { checkoutRecoveryPlan: plan } });
    order = await PaymentOrder.findById(order._id).select(SESSION_FIELDS);
  }
  if (order.checkoutContract) return { order };
  let rejected;
  for (const [index, candidate] of [order.checkoutRecoveryPlan.current, order.checkoutRecoveryPlan.original].entries()) {
    try { session = await stripe.checkout.sessions.create(structuredClone(candidate.request), { idempotencyKey: candidate.key }); return { order, session }; }
    catch (error) {
      reportPaymentFailure(error, "checkout_create", order.testMode ? "test" : "live");
      if (error.type === "StripeInvalidRequestError" && error.statusCode === 400 && error.headers?.["idempotent-replayed"] === "true" && !error.payment_intent) { rejected = true; break; }
      if (index === 0 && error.type === "StripeIdempotencyError") continue;
      throw new ApiError(502, checkoutFailureMessage(error));
    }
  }
  if (!rejected) throw new ApiError(409, "Earlier payment outcome is uncertain. No replacement was opened.");
  session = await legacySession(order, stripe);
  if (session) return { order, session };
  // Only a replayed, definitive 400 plus a complete empty provider scan permits
  // a new operation version. Never rotate on timeouts, 5xx or unknown outcomes.
  await PaymentOrder.collection.updateOne({ _id: order._id, checkoutContract: { $exists: false }, stripeSessionId: { $exists: false }, active: true, status: { $in: ["pending", "failed"] } }, { $set: { checkoutContract: order.checkoutRecoveryPlan.replacement } });
  order = await PaymentOrder.findById(order._id).select(SESSION_FIELDS);
  if (!order.checkoutContract) throw new ApiError(409, "The earlier payment changed. Review its status before retrying.");
  return { order };
}

export function publicOrder(order) {
  return { id: String(order._id), courseId: String(order.course), title: order.title, amountMinor: order.amountMinor, currency: "inr", status: order.status, testMode: order.testMode, refundedMinor: order.refundedMinor, paidAt: order.paidAt, checkoutExpiresAt: order.checkoutExpiresAt };
}
export async function quoteCourse(courseId, user) {
  const course = await requireCourseNomination(courseId, user);
  const mode = stripeMode(), testMode = mode === "test";
  // A course explicitly made free never inherits an older pending paid quote.
  // Historical orders remain intact and can still be reconciled independently.
  if (!course.price) return { courseId: String(course._id), title: course.title, amountMinor: 0, currency: "inr", testMode, paid: false, requiresPayment: false };
  const PaymentOrder = paymentOrderModel(mode);
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
      const initial = { _id: new mongoose.Types.ObjectId(), student: user._id, course: course._id, instructor: course.instructor, title: course.title, amountMinor, currency: "inr", testMode, checkoutExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) };
      initial.checkoutContract = newCheckoutContract(initial, origin);
      order = await PaymentOrder.findOneAndUpdate({ student: user._id, requestKey: hash, testMode }, { $setOnInsert: initial }, { upsert: true, new: true, runValidators: true }).select(SESSION_FIELDS);
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
  let session;
  if (!order.checkoutContract) {
    const recovered = await recoverLegacyCheckout(order, stripe, origin, PaymentOrder);
    order = recovered.order; session = recovered.session;
  }
  if (!session) {
    assertCheckoutContract(order, order.checkoutContract, origin);
    const contractCreated = Date.parse(order.checkoutContract.createdAt);
    if (!Number.isFinite(contractCreated) || contractCreated > Date.now()) throw new ApiError(503, "This saved payment attempt needs configuration review.");
    if (Date.now() - contractCreated >= 24 * 60 * 60 * 1000) {
      // Stripe may prune keys after 24 hours. Never recreate an uncertain old
      // operation merely because its original key can now be accepted again.
      session = await legacySession(order, stripe);
      if (!session) throw new ApiError(409, "The earlier payment's retry window ended. Its outcome needs review; no new checkout was opened.");
    } else {
      try { session = await stripe.checkout.sessions.create(structuredClone(order.checkoutContract.request), { idempotencyKey: order.checkoutContract.key }); }
      catch (error) {
        reportPaymentFailure(error, "checkout_create", mode);
        throw new ApiError(502, checkoutFailureMessage(error));
      }
    }
  }
  assertSession(order, session);
  if (session.status !== "open" || session.payment_status !== "unpaid") {
    const existing = await reconcileOrder(order._id, session.id, stripe);
    throw new ApiError(409, existing.status === "paid" ? "The earlier payment is verified. Refresh the course to open it." : "An earlier payment needs status review. No new checkout was opened.");
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
