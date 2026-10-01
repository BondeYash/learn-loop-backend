import ApiError from "../utils/ApiError.js";
import asyncHandler from "../utils/asyncHandler.js";
import Session from "../models/Session.js";
import { hashToken, SESSION_COOKIE } from "../services/sessionService.js";
export async function findSession(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const session = await Session.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } }).populate({ path: "user", select: "+authVersion" });
  const user = session?.user;
  if (!user || user.status === "suspended" || (session.authVersion || 0) !== (user.authVersion || 0)) return null;
  if (user.mustChangePassword && user.temporaryPasswordExpiresAt < new Date()) return null;
  return session;
}
export const resolveSession = asyncHandler(async (req, res, next) => {
  req.session = await findSession(req);
  req.user = req.session?.user;
  req.sessionResolved = true;
  next();
});
const authenticated = (allowPasswordChange) => asyncHandler(async (req, res, next) => {
  const session = req.sessionResolved ? req.session : await findSession(req);
  if (!session) throw new ApiError(401, "Your session has ended. Please sign in again.");
  req.user = session.user;
  req.session = session;
  if (session.user.mustChangePassword && !allowPasswordChange) {
    return res.status(403).json({ success: false, code: "PASSWORD_CHANGE_REQUIRED", message: "Change your temporary password before continuing." });
  }
  next();
});
export const protect = authenticated(false);
export const protectAccount = authenticated(true);
export const authorize = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return next(new ApiError(403, "You do not have permission to access this resource"));
  next();
};
