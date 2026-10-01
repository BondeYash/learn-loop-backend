import AuditEvent from "../models/AuditEvent.js";
import asyncHandler from "../utils/asyncHandler.js";
// Persist intent before a privileged write. Never retain request bodies, cookies,
// query strings, password-reset links, signed URLs or credentials.
export const auditAdminMutations = asyncHandler(async (req, res, next) => {
  if (req.user?.role !== "admin" || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (!/^\/(admin|courses|uploads|direct-uploads|lessons|categories)(\/|$)/.test(req.path) && req.path !== "/auth/change-password") return next();
  const event = await AuditEvent.create({ actor: req.user._id, action: "admin.write", method: req.method, path: req.path.slice(0, 240) });
  res.once("finish", () => {
    AuditEvent.updateOne({ _id: event._id }, { outcome: res.statusCode < 400 ? "succeeded" : "rejected", httpStatus: res.statusCode, target: res.locals.auditTarget, action: res.locals.auditAction || "admin.write" })
      .catch(() => console.error("Admin audit completion failed; persisted intent remains pending", String(event._id)));
  });
  next();
});
