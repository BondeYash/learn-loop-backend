import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import { authenticateUser, publicUser, registerUser, requestPasswordReset, resetPassword } from "../services/authService.js";
import { createSession, clearSessionCookie, hashToken, SESSION_COOKIE } from "../services/sessionService.js";
import Session from "../models/Session.js";
const respond = async (req, res, status, message, user) => {
  await createSession(res, user, req.cookies?.[SESSION_COOKIE]);
  return new ApiResponse(res, status, message, { user: publicUser(user) });
};
export const register = asyncHandler(async (req, res) => respond(req, res, 201, "Registration successful", await registerUser(req.body)));
export const login = asyncHandler(async (req, res) => respond(req, res, 200, "Login successful", await authenticateUser(req.body)));
export const logout = asyncHandler(async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await Session.deleteOne({ tokenHash: hashToken(token) });
  clearSessionCookie(res);
  return new ApiResponse(res, 200, "Logout successful", {});
});
export const getMe = asyncHandler(async (req, res) => new ApiResponse(res, 200, "User profile retrieved", { user: publicUser(req.user) }));
export const forgotPassword = asyncHandler(async (req, res) => {
  await requestPasswordReset(req.body.email);
  return new ApiResponse(res, 200, "If an account exists for that email, a reset link has been sent", {});
});
export const resetPasswordWithToken = asyncHandler(async (req, res) => {
  const user = await resetPassword({ token: req.params.token, password: req.body.password });
  return respond(req, res, 200, "Password reset successful", user);
});
