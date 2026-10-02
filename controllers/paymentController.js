import { paymentOrderModel } from "../models/PaymentOrder.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import { stripeClient, stripeReadiness, verifyStripeEvent } from "../services/stripeClient.js";
import { handlePaymentEvent, publicOrder, quoteCourse, reconcileOrder, startCheckout } from "../services/payments.js";

const clientFor = (req) => process.env.NODE_ENV === "test" && req.app.locals.stripeClient ? req.app.locals.stripeClient : stripeClient();
export const paymentQuote = asyncHandler(async (req, res) => new ApiResponse(res, 200, "INR course price", { quote: await quoteCourse(req.params.courseId, req.user), readiness: stripeReadiness() }));
export const checkout = asyncHandler(async (req, res) => new ApiResponse(res, 201, "Stripe checkout created", await startCheckout(req.body.courseId, req.user, req.get("Idempotency-Key"), req.body.quotedAmountMinor, clientFor(req))));
export const orderStatus = asyncHandler(async (req, res) => {
  const order = await paymentOrderModel().findOne({ _id: req.params.orderId, student: req.user._id });
  if (!order) throw new ApiError(404, "Payment order not found");
  return new ApiResponse(res, 200, "Payment status", { order: publicOrder(order) });
});
export const refreshOrderStatus = asyncHandler(async (req, res) => {
  const order = await paymentOrderModel().findOne({ _id: req.params.orderId, student: req.user._id }).select("+stripeSessionId");
  if (!order) throw new ApiError(404, "Payment order not found");
  if (!order.stripeSessionId) throw new ApiError(409, "Checkout has not finished opening. Retry the original payment attempt.");
  try { return new ApiResponse(res, 200, "Verified Stripe payment status", { order: publicOrder(await reconcileOrder(order._id, null, clientFor(req))) }); }
  catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(502, "Stripe payment status is temporarily unavailable. Retry shortly."); }
});
export const stripeWebhook = asyncHandler(async (req, res) => {
  const event = verifyStripeEvent(req.body, req.get("Stripe-Signature"));
  const result = await handlePaymentEvent(event, clientFor(req));
  return res.status(200).json({ received: true, ...result });
});
