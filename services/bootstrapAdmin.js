import User from "../models/User.js";
import AuditEvent from "../models/AuditEvent.js";
import ApiError from "../utils/ApiError.js";

// This service has no HTTP route. Only the operator's interactive CLI invokes it.
export async function bootstrapAdmin({ name, email, password }) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 100 || typeof email !== "string" || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, "Provide a valid admin name and email");
  if (typeof password !== "string" || password.length < 16 || Buffer.byteLength(password, "utf8") > 72) throw new ApiError(400, "Use an admin password of at least 16 characters and at most 72 UTF-8 bytes");
  await User.init(); // The sparse unique bootstrap key also prevents concurrent first-admin creation.
  if (await User.exists({ role: "admin" })) throw new ApiError(409, "An administrator already exists. Bootstrap cannot replace, promote or reset accounts.");
  const event = await AuditEvent.create({ action: "admin.bootstrap" });
  try {
    const user = await User.create({ name: name.trim(), email: email.trim().toLowerCase(), password, role: "admin", bootstrapKey: "first-admin-v1" });
    await AuditEvent.updateOne({ _id: event._id }, { outcome: "succeeded", target: String(user._id) });
    return user;
  } catch (error) {
    await AuditEvent.updateOne({ _id: event._id }, { outcome: "rejected" });
    if (error.code === 11000) throw new ApiError(409, "Bootstrap stopped: this email or the first-admin bootstrap key already exists. No existing account was changed.");
    throw error;
  }
}
