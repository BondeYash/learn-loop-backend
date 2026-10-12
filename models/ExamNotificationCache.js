import mongoose from "mongoose";

const noticeSchema = new mongoose.Schema({
  id: String,
  title: String,
  url: String,
  publishedOn: { type: String, default: null },
}, { _id: false });

// A single durable budget shared by every instance, visitor and deployment.
// Do not add a TTL index: expiry would discard the last good feed and its budget.
const schema = new mongoose.Schema({
  _id: String,
  notices: { type: [noticeSchema], default: [] },
  fetchedAt: { type: Date, default: null },
  nextAttemptAt: { type: Date, default: () => new Date(0) },
  attemptId: { type: String, default: "" },
  lastError: { type: String, default: "" },
}, { versionKey: false });

export default mongoose.model("ExamNotificationCache", schema);
