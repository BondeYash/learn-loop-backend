import ApiError from "../utils/ApiError.js";
import asyncHandler from "../utils/asyncHandler.js";
import Session from "../models/Session.js";
import { hashToken, SESSION_COOKIE } from "../services/sessionService.js";
export async function findSession(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const session = await Session.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } }).populate("user");
  return session?.user ? session : null;
}
export const resolveSession = asyncHandler(async (req, res, next) => {
  req.session = await findSession(req);
  req.user = req.session?.user;
  req.sessionResolved = true;
  next();
});
export const protect = asyncHandler(async (req, res, next) => {
  const session = req.sessionResolved ? req.session : await findSession(req);
  if (!session) throw new ApiError(401, "Your session has ended. Please sign in again.");
  req.user = session.user;
  req.session = session;
  next();
});
export const authorize = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return next(new ApiError(403, "You do not have permission to access this resource"));
  next();
};
