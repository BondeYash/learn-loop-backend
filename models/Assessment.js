import mongoose from "mongoose";
export const questionSchema = new mongoose.Schema({
  prompt: String, options: [String], correctIndex: { type: Number, default: null }, explanation: String, topic: String,
}, { _id: false });
const schema = new mongoose.Schema({
  course: { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true, index: true },
  module: { type: mongoose.Schema.Types.ObjectId, ref: "Module", default: null },
  title: { type: String, required: true, maxlength: 160 },
  kind: { type: String, enum: ["quiz", "mock"], required: true },
  durationMinutes: { type: Number, default: null },
  status: { type: String, enum: ["draft", "published"], default: "draft" },
  version: { type: Number, default: 1 },
  questionCount: { type: Number, default: 0 },
  slot: { type: Number, required: true, min: 0, max: 39, validate: Number.isInteger },
  questions: { type: [questionSchema], default: [], select: false },
}, { timestamps: true });
schema.index({ course: 1, slot: 1 }, { unique: true });
export default mongoose.model("Assessment", schema);
