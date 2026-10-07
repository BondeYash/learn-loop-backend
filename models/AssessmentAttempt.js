import mongoose from "mongoose";
import { questionSchema } from "./Assessment.js";
const snapshot = new mongoose.Schema({ title: String, kind: String, version: Number, durationMinutes: Number, feedbackMode: { type: String, enum: ["after_submit", "after_answer"], default: "after_submit" }, questions: [questionSchema] }, { _id: false });
const schema = new mongoose.Schema({
  assessment: { type: mongoose.Schema.Types.ObjectId, ref: "Assessment", required: true },
  course: { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true, index: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  status: { type: String, enum: ["active", "submitted", "timed_out"], default: "active" },
  snapshot: { type: snapshot, required: true, select: false },
  answers: { type: [Number], default: [] },
  revision: { type: Number, default: 0 },
  attemptNumber: { type: Number, required: true, min: 1, max: 100, validate: Number.isInteger },
  startedAt: { type: Date, required: true }, deadline: { type: Date, default: null }, submittedAt: Date,
  result: { correct: Number, total: Number, answered: Number, percentage: Number, topics: [{ _id: false, topic: String, correct: Number, total: Number }] },
}, { timestamps: true });
// Retries/double starts resume one active attempt, including across server instances.
schema.index({ student: 1, assessment: 1 }, { unique: true, partialFilterExpression: { status: "active" } });
schema.index({ student: 1, assessment: 1, attemptNumber: 1 }, { unique: true });
schema.index({ student: 1, course: 1, startedAt: -1 });
export default mongoose.model("AssessmentAttempt", schema);
