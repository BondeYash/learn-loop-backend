import mongoose from "mongoose";
import { stripeMode } from "../services/stripeMode.js";
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  type: { type: String, required: true },
  status: { type: String, enum: ["processing", "processed"], default: "processing" },
  leaseUntil: Date,
  token: { type: String, select: false },
  processedAt: Date,
}, { timestamps: true });
const StripeEvent = mongoose.model("StripeEvent", schema);
export const LiveStripeEvent = mongoose.model("LiveStripeEvent", schema.clone(), "livestripeevents");
export function stripeEventModel(mode = stripeMode()) {
  if (mode !== "test" && mode !== "live") throw new Error("Invalid payment mode");
  return mode === "test" ? StripeEvent : LiveStripeEvent;
}
export default StripeEvent;
