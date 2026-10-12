import crypto from "node:crypto";
import { paymentOrderModel } from "../models/PaymentOrder.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import { razorpayClient, razorpayReadiness, verifyRazorpayEvent } from "../services/razorpayClient.js";
import { handlePaymentEvent, ORDER_FIELDS, publicOrder, quoteCourse, reconcileOrder, startCheckout, verifyCheckout } from "../services/payments.js";
import { paymentMode } from "../services/paymentSettings.js";
import { requireCourseAccess } from "../services/courseAccess.js";
import Course from "../models/Course.js";
import { captureAttribution } from "../services/acquisition.js";

async function orderView(order, user) {
  let canAccess = false;
  try { await requireCourseAccess(order.course, user); canAccess = true; }
  catch (error) { if (!(error instanceof ApiError) || ![402, 403, 404, 410].includes(error.statusCode)) throw error; }
  return { ...publicOrder(order), canAccess };
}
async function ownedOrder(req) {
  const order = await paymentOrderModel().findOne({ _id: req.params.orderId, student: req.user._id }).select(ORDER_FIELDS);
  if (!order) throw new ApiError(404, "Payment order not found");
  return order;
}
const clientFor = (req) => process.env.NODE_ENV === "test" && req.app.locals.razorpayClient ? req.app.locals.razorpayClient : razorpayClient();
export const paymentHistory = asyncHandler(async (req, res) => {
  const page = Number(req.query.page || 1), limit = Number(req.query.limit || 20), testMode = paymentMode() === "test";
  const filter = { student: req.user._id, testMode };
  const [orders, total] = await Promise.all([paymentOrderModel().find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit), paymentOrderModel().countDocuments(filter)]);
  return new ApiResponse(res, 200, "Your payment history", { orders: orders.map(publicOrder), page, limit, total, testMode });
});
export const paymentQuote = asyncHandler(async (req, res) => new ApiResponse(res, 200, "INR course price", { quote: await quoteCourse(req.params.courseId, req.user), readiness: razorpayReadiness() }));
export const checkout = asyncHandler(async (req, res) => {
  const result = await startCheckout(req.body.courseId, req.user, req.get("Idempotency-Key"), req.body.quotedAmountMinor, clientFor(req));
  if (result.order?.testMode === false && req.body.attribution?.consent === true) { try { await captureAttribution(await Course.findById(req.body.courseId), req.user, req.body.attribution); } catch { /* Elective only. */ } }
  return new ApiResponse(res, 201, "Razorpay checkout created", result);
});
export const orderStatus = asyncHandler(async (req, res) => new ApiResponse(res, 200, "Payment status", { order: await orderView(await ownedOrder(req), req.user) }));
export const refreshOrderStatus = asyncHandler(async (req, res) => {
  const order = await ownedOrder(req);
  const current = order.provider === "razorpay" ? await reconcileOrder(order._id, clientFor(req)) : order;
  return new ApiResponse(res, 200, "Payment status checked", { order: await orderView(current, req.user) });
});
export const verifyPayment = asyncHandler(async (req, res) => {
  const order = await ownedOrder(req);
  const current = await verifyCheckout(order, req.body, clientFor(req));
  return new ApiResponse(res, 200, "Razorpay payment checked", { order: await orderView(current, req.user) });
});
export const razorpayWebhookHealth = (req, res) => {
  const readiness = razorpayReadiness();
  return res.status(200).json({ success: true, message: "Razorpay webhook endpoint is deployed", data: readiness });
};
export const razorpayWebhook = asyncHandler(async (req, res) => {
  const event = verifyRazorpayEvent(req.body, req.get("X-Razorpay-Signature"));
  const eventId = req.get("X-Razorpay-Event-Id") || crypto.createHash("sha256").update(req.body).digest("hex");
  const result = await handlePaymentEvent(event, eventId, clientFor(req));
  return res.status(200).json({ received: true, ...result });
});
