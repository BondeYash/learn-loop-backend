import rateLimit from "express-rate-limit";
// Authenticated accounts get separate request budgets, so a shared school IP does not
// make one instructor's processing polls block every student's dashboard.
export const apiLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 1200,
  keyGenerator: (req) => req.user ? `user:${req.user._id}` : req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests. Please retry shortly." },
});
export const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 30, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, message: { success: false, message: "Too many attempts. Please try again later." } });
const activeChunks = new Map();
export function limitConcurrentChunks(req, res, next) {
  const key = String(req.user._id);
  const count = activeChunks.get(key) || 0;
  if (count >= 2) return res.status(429).set("Retry-After", "2").json({ success: false, message: "Two chunks are already uploading. Please retry shortly." });
  activeChunks.set(key, count + 1);
  let released = false;
  const release = () => { if (released) return; released = true; const remaining = (activeChunks.get(key) || 1) - 1; if (remaining) activeChunks.set(key, remaining); else activeChunks.delete(key); };
  res.once("close", release); res.once("finish", release);
  next();
}
