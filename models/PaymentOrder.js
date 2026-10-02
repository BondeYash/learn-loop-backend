import mongoose from "mongoose";
import { stripeMode } from "../services/stripeMode.js";
const integer = (value) => Number.isSafeInteger(value);
const schema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  course: { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true, index: true },
  instructor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  title: { type: String, required: true, maxlength: 160 },
  currency: { type: String, enum: ["inr"], default: "inr" },
  amountMinor: { type: Number, required: true, min: 50, max: 99999999, validate: integer },
  requestKey: { type: String, required: true, select: false },
  testMode: { type: Boolean, default: true, immutable: true, validate: (value) => value === true },
  status: { type: String, enum: ["pending", "paid", "failed", "expired", "partially_refunded", "refunded", "disputed", "reversed"], default: "pending", index: true },
  active: { type: Boolean, default: true },
  stripeSessionId: { type: String, select: false },
  stripePaymentIntentId: { type: String, select: false },
  checkoutUrl: { type: String, select: false },
  checkoutExpiresAt: { type: Date, required: true },
  refundedMinor: { type: Number, default: 0, min: 0, validate: integer },
  paidAt: Date,
  lastStripeEventAt: Date,
  reconciliationToken: { type: String, select: false },
  reconciliationLeaseUntil: Date,
}, { timestamps: true });
schema.index({ student: 1, requestKey: 1 }, { unique: true });
schema.index({ student: 1, course: 1 }, { unique: true, partialFilterExpression: { active: true } });
schema.index({ stripeSessionId: 1 }, { unique: true, sparse: true });
schema.index({ stripePaymentIntentId: 1 }, { unique: true, sparse: true });
const PaymentOrder = mongoose.model("PaymentOrder", schema);
// Separate collections preserve existing test records and indexes without a
// production data/index migration. Test payments cannot authorize live access.
const liveSchema = schema.clone();
liveSchema.path("testMode").default(false);
liveSchema.path("testMode").validators = [];
liveSchema.path("testMode").validate((value) => value === false);
export const LivePaymentOrder = mongoose.model("LivePaymentOrder", liveSchema, "livepaymentorders");
export function paymentOrderModel(mode = stripeMode()) {
  if (mode !== "test" && mode !== "live") throw new Error("Invalid payment mode");
  return mode === "test" ? PaymentOrder : LivePaymentOrder;
}
export default PaymentOrder;
