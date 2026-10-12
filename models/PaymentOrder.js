import mongoose from "mongoose";
import { paymentMode } from "../services/paymentSettings.js";
const integer = (value) => Number.isSafeInteger(value);
const schema = new mongoose.Schema({
  provider: { type: String, enum: ["legacy", "razorpay"], default: "legacy", immutable: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  course: { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true, index: true },
  instructor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  title: { type: String, required: true, maxlength: 160 },
  enrollmentType: { type: String, enum: ["assigned", "public", "purchase"], default: "assigned", immutable: true },
  publicEnrollmentRequestedAt: Date,
  currency: { type: String, enum: ["inr"], default: "inr" },
  amountMinor: { type: Number, required: true, min: 50, max: 99999999, validate: integer },
  requestKey: { type: String, required: true, select: false },
  testMode: { type: Boolean, default: true, immutable: true, validate: (value) => value === true },
  status: { type: String, enum: ["pending", "paid", "failed", "expired", "partially_refunded", "refunded", "disputed", "reversed"], default: "pending", index: true },
  active: { type: Boolean, default: true },
  razorpayOrderId: { type: String, select: false },
  razorpayPaymentId: { type: String, select: false },
  creationToken: { type: String, select: false },
  creationLeaseUntil: Date,
  creationStartedAt: Date,
  checkoutContract: { type: mongoose.Schema.Types.Mixed, select: false, immutable: true },
  checkoutExpiresAt: Date, // Historical hosted-checkout records only.
  refundedMinor: { type: Number, default: 0, min: 0, validate: integer },
  paidAt: Date,
  reconciliationToken: { type: String, select: false },
  reconciliationLeaseUntil: Date,
}, { timestamps: true });
schema.index({ student: 1, requestKey: 1 }, { unique: true });
schema.index({ student: 1, course: 1 }, { unique: true, partialFilterExpression: { active: true } });
schema.index({ razorpayOrderId: 1 }, { unique: true, sparse: true });
schema.index({ razorpayPaymentId: 1 }, { unique: true, sparse: true });
const PaymentOrder = mongoose.model("PaymentOrder", schema);
// Separate collections preserve existing test records and indexes without a
// production data/index migration. Test payments cannot authorize live access.
const liveSchema = schema.clone();
liveSchema.path("testMode").default(false);
liveSchema.path("testMode").validators = [];
liveSchema.path("testMode").validate((value) => value === false);
export const LivePaymentOrder = mongoose.model("LivePaymentOrder", liveSchema, "livepaymentorders");
export function paymentOrderModel(mode = paymentMode()) {
  if (mode !== "test" && mode !== "live") throw new Error("Invalid payment mode");
  return mode === "test" ? PaymentOrder : LivePaymentOrder;
}
export default PaymentOrder;
