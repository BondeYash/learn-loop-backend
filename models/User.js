import bcrypt from "bcryptjs";
import crypto from "crypto";
import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, "Name is required"], trim: true, maxlength: 100 },
    email: { type: String, required: [true, "Email is required"], unique: true, lowercase: true, trim: true },
    password: { type: String, required: [true, "Password is required"], minlength: 8, select: false },
    role: { type: String, enum: ["student", "instructor", "admin"], default: "student" },
    status: { type: String, enum: ["active", "suspended"], default: "active" },
    mustChangePassword: { type: Boolean, default: false },
    temporaryPasswordExpiresAt: Date,
    authVersion: { type: Number, default: 0, select: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    bootstrapKey: { type: String, select: false },
    avatar: { type: String, default: "" },
    bio: { type: String, default: "", maxlength: 1000 },
    resetPasswordToken: { type: String, select: false },
    resetPasswordExpires: { type: Date, select: false },
  },
  { timestamps: true }
);
// Only the explicit bootstrap command uses this key. Existing admins are preserved.
userSchema.index({ bootstrapKey: 1 }, { unique: true, sparse: true });
userSchema.index({ role: 1, createdAt: -1 });

userSchema.pre("save", async function hashPassword(next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = function comparePassword(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.createPasswordResetToken = function createPasswordResetToken() {
  const resetToken = crypto.randomBytes(32).toString("hex");
  this.resetPasswordToken = crypto.createHash("sha256").update(resetToken).digest("hex");
  this.resetPasswordExpires = new Date(Date.now() + 10 * 60 * 1000);
  return resetToken;
};

export default mongoose.model("User", userSchema);
