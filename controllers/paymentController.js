import { paymentOrderModel } from "../models/PaymentOrder.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import { stripeClient, stripeReadiness, verifyStripeEvent } from "../services/stripeClient.js";
import { handlePaymentEvent, publicOrder, quoteCourse, reconcileOrder, startCheckout } from "../services/payments.js";
import { reportPaymentFailure } from "../services/paymentDiagnostics.js";
import { stripeMode } from "../services/stripeMode.js";
import { requireCourseAccess } from "../services/courseAccess.js";

async function orderView(order, user) {
  let canAccess = false;
  try { await requireCourseAccess(order.course, user); canAccess = true; }
  catch (error) { if (!(error instanceof ApiError) || ![402, 403, 404, 410].includes(error.statusCode)) throw error; }
  return { ...publicOrder(order), canAccess };
}
export const paymentHistory = asyncHandler(async (req, res) => {
  const page = Number(req.query.page || 1), limit = Number(req.query.limit || 20);
  const filter = { student: req.user._id, testMode: stripeMode() === "test" };
  const [orders, total] = await Promise.all([paymentOrderModel().find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit), paymentOrderModel().countDocuments(filter)]);
  return new ApiResponse(res, 200, "Your payment history", { orders: orders.map(publicOrder), page, limit, total, testMode: filter.testMode });
});

const clientFor = (req) => process.env.NODE_ENV === "test" && req.app.locals.stripeClient ? req.app.locals.stripeClient : stripeClient();
export const paymentQuote = asyncHandler(async (req, res) => new ApiResponse(res, 200, "INR course price", { quote: await quoteCourse(req.params.courseId, req.user), readiness: stripeReadiness() }));
export const checkout = asyncHandler(async (req, res) => new ApiResponse(res, 201, "Stripe checkout created", await startCheckout(req.body.courseId, req.user, req.get("Idempotency-Key"), req.body.quotedAmountMinor, clientFor(req))));
export const orderStatus = asyncHandler(async (req, res) => {
  const order = await paymentOrderModel().findOne({ _id: req.params.orderId, student: req.user._id });
  if (!order) throw new ApiError(404, "Payment order not found");
  return new ApiResponse(res, 200, "Payment status", { order: await orderView(order, req.user) });
});
export const refreshOrderStatus = asyncHandler(async (req, res) => {
  const order = await paymentOrderModel().findOne({ _id: req.params.orderId, student: req.user._id }).select("+stripeSessionId");
  if (!order) throw new ApiError(404, "Payment order not found");
  if (!order.stripeSessionId) throw new ApiError(409, "Checkout has not finished opening. Retry the original payment attempt.");
  try { return new ApiResponse(res, 200, "Verified Stripe payment status", { order: await orderView(await reconcileOrder(order._id, null, clientFor(req)), req.user) }); }
  catch (error) { if (error instanceof ApiError) throw error; reportPaymentFailure(error, "order_refresh", stripeMode()); throw new ApiError(502, "Stripe payment status is temporarily unavailable. Retry shortly."); }
});
export const stripeWebhook = asyncHandler(async (req, res) => {
  const event = verifyStripeEvent(req.body, req.get("Stripe-Signature"));
  let result;
  try { result = await handlePaymentEvent(event, clientFor(req)); }
  catch (error) { if (!(error instanceof ApiError)) reportPaymentFailure(error, "webhook_reconcile", stripeMode()); throw error; }
  return res.status(200).json({ received: true, ...result });
});
