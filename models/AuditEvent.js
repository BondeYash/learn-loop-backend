import mongoose from "mongoose";
const schema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  action: { type: String, required: true, maxlength: 80 },
  method: String,
  path: { type: String, maxlength: 240 },
  target: { type: String, maxlength: 100 },
  outcome: { type: String, enum: ["pending", "succeeded", "rejected"], default: "pending" },
  httpStatus: Number,
}, { timestamps: true });
schema.index({ createdAt: -1 });
schema.index({ actor: 1, createdAt: -1 });
export default mongoose.model("AuditEvent", schema);
