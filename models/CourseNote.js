import mongoose from "mongoose";

const schema = new mongoose.Schema({
  course: { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  slot: { type: Number, required: true, min: 0, max: 19 },
  uploadId: { type: String, required: true },
  filename: { type: String, required: true },
  size: { type: Number, required: true },
  sha256: { type: String, required: true },
  pages: Number,
  storageBucket: String,
  objectKey: String,
  status: { type: String, enum: ["uploading", "ready", "failed", "removing"], default: "uploading" },
  leaseUntil: Date,
}, { timestamps: true });
// Fixed slots bound each course to twenty notes even during concurrent requests.
schema.index({ course: 1, slot: 1 }, { unique: true });
schema.index({ course: 1, uploadId: 1 }, { unique: true });
export default mongoose.model("CourseNote", schema);
