import crypto from "node:crypto";
import mongoose from "mongoose";
import ApiError from "../utils/ApiError.js";
const schema = new mongoose.Schema({ _id: String, token: String, expiresAt: Date });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const UploadCreationLock = mongoose.model("UploadCreationLock", schema);

// Serialize only the short database allocation step, never the file transfer.
// Counting unfinished assets without this lock lets concurrent tabs exceed it.
export async function withUploadCreationLock(owner, operation) {
  const key = String(owner), token = crypto.randomUUID(), until = Date.now() + 2000;
  let acquired = false;
  do {
    try {
      const lease = await UploadCreationLock.findOneAndUpdate({ _id: key, expiresAt: { $lt: new Date() } }, { token, expiresAt: new Date(Date.now() + 60000) }, { upsert: true, new: true });
      acquired = lease.token === token;
    } catch (error) { if (error.code !== 11000) throw error; }
    if (!acquired) await new Promise(resolve => setTimeout(resolve, 40));
  } while (!acquired && Date.now() < until);
  if (!acquired) throw new ApiError(429, "Another upload is being opened. Please retry shortly.");
  try { return await operation(); }
  finally { await UploadCreationLock.deleteOne({ _id: key, token }); }
}
