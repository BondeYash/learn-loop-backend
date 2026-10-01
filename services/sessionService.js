import crypto from "node:crypto";
import Session from "../models/Session.js";
export const SESSION_COOKIE = "lms_session";
export const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
const options = () => ({ httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api" });
export const clearSessionCookie = (res) => res.clearCookie(SESSION_COOKIE, options());
export async function createSession(res, user, previousToken) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + (user.mustChangePassword ? 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000));
  await Session.create({ user: user._id, authVersion: user.authVersion || 0, tokenHash: hashToken(token), expiresAt });
  if (previousToken) await Session.deleteOne({ tokenHash: hashToken(previousToken) });
  res.cookie(SESSION_COOKIE, token, { ...options(), expires: expiresAt });
}
