import crypto from "crypto";
import Session from "../models/Session.js";
import nodemailer from "nodemailer";
import ApiError from "../utils/ApiError.js";
import User from "../models/User.js";
import bcrypt from "bcryptjs";

export const publicUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  avatar: user.avatar,
  bio: user.bio,
  status: user.status || "active",
  mustChangePassword: Boolean(user.mustChangePassword),
});

export const registerUser = async ({ name, email, password, role }) => {
  const existingUser = await User.findOne({ email });
  if (existingUser) throw new ApiError(409, "An account with this email already exists");
  if (role && role !== "student") throw new ApiError(400, "Instructor accounts must be created by an administrator");
  return User.create({ name, email, password, role: "student" });
};

export const authenticateUser = async ({ email, password }) => {
  const user = await User.findOne({ email }).select("+password +authVersion");
  if (!user || !(await user.comparePassword(password))) {
    throw new ApiError(401, "Invalid email or password");
  }
  if (user.status === "suspended") throw new ApiError(403, "Your account access is paused. Contact your administrator.");
  if (user.mustChangePassword && user.temporaryPasswordExpiresAt < new Date()) throw new ApiError(403, "Your temporary password has expired. Ask your administrator for a new one.");
  return user;
};

export const requestPasswordReset = async (email) => {
  const smtpHost = process.env.SMTP_HOST || process.env.EMAIL_HOST;
  const smtpPort = process.env.SMTP_PORT || process.env.EMAIL_PORT;
  const smtpUser = process.env.SMTP_USER || process.env.EMAIL_USER;
  const smtpPass = process.env.SMTP_PASS || process.env.EMAIL_PASSWORD;
  if (!smtpHost || !smtpUser || !smtpPass) {
    throw new ApiError(503, "Password reset email is not configured. Contact the administrator.");
  }


  const user = await User.findOne({ email }).select("+resetPasswordToken +resetPasswordExpires");
  // Do not reveal whether the address is registered.
  if (!user || user.status === "suspended") return null;

  const resetToken = user.createPasswordResetToken();
  await user.save({ validateBeforeSave: false });
  const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";
  const resetUrl = `${clientUrl}/reset-password/${resetToken}`;


  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: Number(smtpPort) || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: smtpUser, pass: smtpPass },
  });
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || smtpUser,
    to: user.email,
    subject: "Reset your LMS password",
    text: `Reset your password using this link: ${resetUrl}\nThis link expires in 10 minutes.`,
  });
  return null;
};

export const resetPassword = async ({ token, password }) => {
  const hashedToken = crypto.createHash("sha256").update(token).digest("hex");
  const digest = await bcrypt.hash(password, 12);
  const user = await User.findOneAndUpdate({ resetPasswordToken: hashedToken, resetPasswordExpires: { $gt: new Date() }, status: { $ne: "suspended" } }, {
    $set: { password: digest, mustChangePassword: false },
    $inc: { authVersion: 1 },
    $unset: { resetPasswordToken: 1, resetPasswordExpires: 1, temporaryPasswordExpiresAt: 1 },
  }, { new: true }).select("+authVersion");
  if (!user) throw new ApiError(400, "Password reset token is invalid or has expired");
  await Session.deleteMany({ user: user._id });
  return user;
};

export const changePassword = async (userId, { currentPassword, password }, expectedVersion) => {
  const existing = await User.findById(userId).select("+password +authVersion");
  if (!existing || existing.status === "suspended" || (existing.authVersion || 0) !== expectedVersion) throw new ApiError(401, "Your session has ended. Please sign in again.");
  if (!(await existing.comparePassword(currentPassword))) throw new ApiError(400, "Your current password is incorrect");
  if (await existing.comparePassword(password)) throw new ApiError(400, "Choose a different password from your current password");
  const digest = await bcrypt.hash(password, 12);
  // Match the old hash as well as status. Concurrent password changes/reset cannot both win.
  const version = expectedVersion === 0 ? { $or: [{ authVersion: 0 }, { authVersion: { $exists: false } }] } : { authVersion: expectedVersion };
  const user = await User.findOneAndUpdate({ _id: userId, password: existing.password, status: { $ne: "suspended" }, ...version }, {
    $set: { password: digest, mustChangePassword: false }, $inc: { authVersion: 1 },
    $unset: { temporaryPasswordExpiresAt: 1, resetPasswordToken: 1, resetPasswordExpires: 1 },
  }, { new: true }).select("+authVersion");
  if (!user) throw new ApiError(409, "Your account changed. Sign in again before retrying.");
  await Session.deleteMany({ user: user._id });
  return user;
};
