import mongoose from "mongoose";
const oid = (ref) => ({ type: mongoose.Schema.Types.ObjectId, ref, required: true });
const settings = new mongoose.Schema({
  _id: { type: String, default: "global" }, enabled: { type: Boolean, default: true },
  monthlyAnswers: { type: Number, default: 500 }, dailyAnswers: { type: Number, default: 20 },
  monthlyPages: { type: Number, default: 1000 }, storageMb: { type: Number, default: 100 },
  courseDocuments: { type: Number, default: 100 }, updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
}, { timestamps: true });
export const DoubtSettings = mongoose.model("DoubtSettings", settings);
const kb = new mongoose.Schema({ course: oid("Course"), storeName: String, leaseUntil: Date, removing: { type: Boolean, default: false } }, { timestamps: true });
kb.index({ course: 1 }, { unique: true });
export const DoubtKnowledgeBase = mongoose.model("DoubtKnowledgeBase", kb);
const document = new mongoose.Schema({
  course: oid("Course"), owner: oid("User"), uploadId: String, filename: String, title: String, size: Number, pages: Number,
  sha256: String, storageBucket: String, objectKey: String,
  status: { type: String, enum: ["uploading", "queued", "indexing", "ready", "failed", "removing"], default: "uploading" },
  published: { type: Boolean, default: false }, publishedAt: Date, leaseUntil: Date, nextAttemptAt: Date,
  operationName: String, providerDocument: String, indexingCharged: { type: Boolean, default: false }, indexStartedAt: Date, error: String,
  searchVersion: Number, chunkCount: Number, textPages: Number,
}, { timestamps: true });
document.index({ course: 1, uploadId: 1 }, { unique: true });
document.index({ course: 1, sha256: 1 }, { unique: true });
document.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 });
document.index({ course: 1, createdAt: -1 });
document.index({ course: 1, status: 1, published: 1 });
export const DoubtDocument = mongoose.model("DoubtDocument", document);
const chunk = new mongoose.Schema({ course: oid("Course"), document: oid("DoubtDocument"), position: Number, page: Number, text: String, terms: [String], version: Number });
chunk.index({ document: 1, position: 1 }, { unique: true });
chunk.index({ course: 1, terms: 1 });
export const DoubtChunk = mongoose.model("DoubtChunk", chunk);
const source = new mongoose.Schema({ document: oid("DoubtDocument"), filename: String, page: Number, excerpt: String }, { _id: false });
const turn = new mongoose.Schema({
  course: oid("Course"), student: oid("User"), requestId: String, question: String, language: String,
  status: { type: String, enum: ["pending", "answered", "unanswered", "failed"], default: "pending" },
  answer: String, sources: [source], feedback: { type: String, enum: ["helpful", "unhelpful", null], default: null },
  inputTokens: Number, outputTokens: Number, model: String, leaseUntil: Date,
}, { timestamps: true });
turn.index({ student: 1, requestId: 1 }, { unique: true });
turn.index({ course: 1, student: 1, createdAt: -1 });
turn.index({ status: 1, createdAt: -1 });
turn.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 86400 });
export const DoubtTurn = mongoose.model("DoubtTurn", turn);
const usage = new mongoose.Schema({ _id: String, answers: { type: Number, default: 0 }, documents: { type: Number, default: 0 }, pages: { type: Number, default: 0 }, bytes: { type: Number, default: 0 }, inputTokens: { type: Number, default: 0 }, outputTokens: { type: Number, default: 0 }, expiresAt: Date }, { timestamps: true });
usage.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const DoubtUsage = mongoose.model("DoubtUsage", usage);
const lock = new mongoose.Schema({ _id: String, leaseUntil: Date });
lock.index({ leaseUntil: 1 }, { expireAfterSeconds: 0 });
export const DoubtLock = mongoose.model("DoubtLock", lock);
export const doubtModels = [DoubtSettings, DoubtKnowledgeBase, DoubtDocument, DoubtChunk, DoubtTurn, DoubtUsage, DoubtLock];
