import mongoose from "mongoose";
import { razorpayMode } from "../services/paymentSettings.js";
const schema = new mongoose.Schema({
  _id: { type: String, required: true }, type: { type: String, required: true },
  status: { type: String, enum: ["processing", "processed"], default: "processing" },
  leaseUntil: Date, token: { type: String, select: false }, processedAt: Date,
}, { timestamps: true });
const RazorpayEvent = mongoose.model("RazorpayEvent", schema);
const LiveRazorpayEvent = mongoose.model("LiveRazorpayEvent", schema.clone(), "liverazorpayevents");
export function razorpayEventModel(mode = razorpayMode()) {
  if (!["test", "live"].includes(mode)) throw new Error("Invalid Razorpay mode");
  return mode === "test" ? RazorpayEvent : LiveRazorpayEvent;
}
