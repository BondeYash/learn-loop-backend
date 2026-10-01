import mongoose from "mongoose";
const schema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  lesson: { type: mongoose.Schema.Types.ObjectId, ref: "Lesson", required: true },
  course: { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true },
  fingerprint: { type: String, required: true },
  filename: String,
  size: { type: Number, required: true },
  chunkSize: { type: Number, required: true },
  checksumVersion: Number,
  uploadMode: { type: String, enum: ["legacy", "direct"], default: "legacy" },
  uploadKey: String,
  width: Number,
  height: Number,
  chunkCount: { type: Number, required: true },
  status: { type: String, enum: ["uploading", "verifying", "queued", "processing", "ready", "failed", "cancelled"], default: "uploading", index: true },
  cleanedAt: Date,
  error: { type: String, default: "" },
  duration: Number,
  outputSize: Number,
  storageProvider: { type: String, enum: ["local", "r2"], default: "local" },
  storageBucket: String,
  objectKey: String,
  processingToken: String,
  leaseUntil: Date,
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
schema.index({ lesson: 1, fingerprint: 1 }, { unique: true });
export default mongoose.model("VideoAsset", schema);
