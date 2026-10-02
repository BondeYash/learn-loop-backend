import mongoose from "mongoose";
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  type: { type: String, required: true },
  status: { type: String, enum: ["processing", "processed"], default: "processing" },
  leaseUntil: Date,
  token: { type: String, select: false },
  processedAt: Date,
}, { timestamps: true });
export default mongoose.model("StripeEvent", schema);
