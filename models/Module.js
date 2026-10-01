import mongoose from "mongoose";
const moduleSchema = new mongoose.Schema({
  course: { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true, index: true },
  title: { type: String, required: [true, "Module title is required"], trim: true, maxlength: 160 },
  order: { type: Number, required: true, min: 0 },
}, { timestamps: true });
moduleSchema.index({ course: 1, order: 1 }, { unique: true });
export default mongoose.model("Module", moduleSchema);
