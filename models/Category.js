import mongoose from "mongoose";
import slugify from "slugify";

const categorySchema = new mongoose.Schema({
  name: { type: String, required: [true, "Category name is required"], trim: true, unique: true, maxlength: 80 },
  slug: { type: String, unique: true, index: true },
  description: { type: String, trim: true, maxlength: 500, default: "" },
}, { timestamps: true });

categorySchema.pre("validate", function setSlug(next) {
  if (this.isModified("name")) this.slug = slugify(this.name, { lower: true, strict: true });
  next();
});

export default mongoose.model("Category", categorySchema);
