import mongoose from "mongoose";
const lessonSchema = new mongoose.Schema({
  course: { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true, index: true },
  module: { type: mongoose.Schema.Types.ObjectId, ref: "Module", required: true, index: true },
  title: { type: String, required: [true, "Lesson title is required"], trim: true, maxlength: 160 },
  contentType: { type: String, enum: ["video", "pdf", "text"], default: "video" },
  video: { type: mongoose.Schema.Types.ObjectId, ref: "VideoAsset", default: null },
  contentUrl: { type: String, trim: true, default: "" },
  content: { type: String, trim: true, maxlength: 50000, default: "" },
  duration: { type: Number, default: 0, min: 0 },
  order: { type: Number, required: true, min: 0 },
  isPreview: { type: Boolean, default: false },
}, { timestamps: true });
lessonSchema.index({ module: 1, order: 1 }, { unique: true });
export default mongoose.model("Lesson", lessonSchema);
