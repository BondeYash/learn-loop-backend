import mongoose from "mongoose";
import slugify from "slugify";

const thumbnailSchema = new mongoose.Schema({ url: { type: String, default: "" }, publicId: { type: String, default: "" }, objectKey: { type: String, select: false }, storageBucket: { type: String, select: false }, size: { type: Number, select: false }, width: Number, height: Number }, { _id: false });
const courseSchema = new mongoose.Schema({
  title: { type: String, required: [true, "Course title is required"], trim: true, maxlength: 160 },
  slug: { type: String, unique: true, index: true },
  description: { type: String, required: [true, "Course description is required"], trim: true, maxlength: 10000 },
  instructor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  category: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: [true, "Course category is required"], index: true },
  thumbnail: { type: thumbnailSchema, default: () => ({}) },
  price: { type: Number, default: 0, min: 0 },
  level: { type: String, enum: ["beginner", "intermediate", "advanced"], default: "beginner" },
  language: { type: String, trim: true, default: "English", maxlength: 50 },
  requirements: [{ type: String, trim: true, maxlength: 300 }],
  learningOutcomes: [{ type: String, trim: true, maxlength: 300 }],
  isPublished: { type: Boolean, default: false, index: true },
  publishedAt: Date,
  archivedAt: { type: Date, default: null, index: true },
  archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  averageRating: { type: Number, default: 0, min: 0, max: 5 },
  ratingCount: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

courseSchema.pre("validate", function setSlug(next) {
  if (this.isModified("title")) this.slug = slugify(`${this.title}-${this._id}`, { lower: true, strict: true });
  next();
});

export default mongoose.model("Course", courseSchema);
