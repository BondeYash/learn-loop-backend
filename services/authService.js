import crypto from "crypto";
import Session from "../models/Session.js";
import nodemailer from "nodemailer";
import ApiError from "../utils/ApiError.js";
import User from "../models/User.js";

export const publicUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  avatar: user.avatar,
  bio: user.bio,
});

export const registerUser = async ({ name, email, password, role }) => {
  const existingUser = await User.findOne({ email });
  if (existingUser) throw new ApiError(409, "An account with this email already exists");
  if (role && !["student", "instructor"].includes(role)) throw new ApiError(400, "Choose student or instructor");
  return User.create({ name, email, password, role: role || "student" });
};

export const authenticateUser = async ({ email, password }) => {
  const user = await User.findOne({ email }).select("+password");
  if (!user || !(await user.comparePassword(password))) {
    throw new ApiError(401, "Invalid email or password");
  }
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
  if (!user) return null;

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
  const user = await User.findOne({ resetPasswordToken: hashedToken, resetPasswordExpires: { $gt: new Date() } })
    .select("+password +resetPasswordToken +resetPasswordExpires");
  if (!user) throw new ApiError(400, "Password reset token is invalid or has expired");
  user.password = password;
  user.resetPasswordToken = undefined;
  user.resetPasswordExpires = undefined;
  await user.save();
  await Session.deleteMany({ user: user._id });
  return user;
};
