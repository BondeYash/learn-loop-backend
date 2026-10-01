import path from "node:path";
import crypto from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, open, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import ApiError from "../utils/ApiError.js";
export const storageRoot = () => path.resolve(process.env.VIDEO_STORAGE_DIR || "storage/videos");
export const assetDir = (id) => path.join(storageRoot(), String(id));
export const chunkPath = (id, index) => path.join(assetDir(id), `${index}.chunk`);
export const outputPath = (asset) => path.join(assetDir(asset._id), `${asset.processingToken}.mp4`);
export const CHUNK_SIZE = 5 * 1024 * 1024;
export const maxVideoBytes = () => Number(process.env.MAX_VIDEO_BYTES) || 2 * 1024 ** 3;
export async function listChunks(asset) {
  const files = await readdir(assetDir(asset._id)).catch((e) => { if (e.code === "ENOENT") return []; throw e; });
  return files.filter((f) => /^\d+\.chunk$/.test(f)).map((f) => Number(f.split(".")[0])).sort((a, b) => a - b);
}
export async function hashFile(filename) {
  const hash = crypto.createHash("sha256");
  for await (const data of createReadStream(filename)) hash.update(data);
  return hash.digest("hex");
}
export async function storeChunk(asset, index, digest, stream) {
  if (!Number.isInteger(index) || index < 0 || index >= asset.chunkCount) throw new ApiError(400, "Invalid chunk index");
  if (!/^[a-f0-9]{64}$/.test(digest || "")) throw new ApiError(400, "A SHA-256 chunk checksum is required");
  const expected = Math.min(asset.chunkSize, asset.size - index * asset.chunkSize);
  const target = chunkPath(asset._id, index);
  await mkdir(assetDir(asset._id), { recursive: true });
  const existing = await stat(target).catch((e) => { if (e.code === "ENOENT") return null; throw e; });
  if (existing) {
    if (existing.size !== expected || await hashFile(target) !== digest) throw new ApiError(409, "This chunk belongs to a different file. Select the original file.");
    await writeFile(`${target}.sha256`, digest);
    stream.resume();
    return;
  }
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  let size = 0;
  const hash = crypto.createHash("sha256");
  const validate = new Transform({ transform(data, encoding, callback) {
    size += data.length;
    if (size > expected) return callback(new ApiError(413, "Chunk exceeds expected size"));
    hash.update(data); callback(null, data);
  } });
  try {
    await pipeline(stream, validate, createWriteStream(temporary, { flags: "wx" }));
    if (size !== expected || hash.digest("hex") !== digest) throw new ApiError(400, "Incomplete or corrupt chunk. Retry this upload.");
    // A filesystem link publishes a complete chunk atomically without replacing a concurrent request.
    const { link } = await import("node:fs/promises");
    try { await link(temporary, target); } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (await hashFile(target) !== digest) throw new ApiError(409, "Conflicting chunk; select the original file");
    }
    await writeFile(`${target}.sha256`, digest);
  } finally { await rm(temporary, { force: true }); }
}
export async function assemble(asset, destination) {
  const handle = await open(destination, "w");
  try {
    for (let index = 0; index < asset.chunkCount; index++) {
      const chunk = await readFile(chunkPath(asset._id, index));
      if (chunk.length !== Math.min(asset.chunkSize, asset.size - index * asset.chunkSize)) throw new Error("An upload chunk is incomplete; upload the file again.");
      const checksumFile = `${chunkPath(asset._id, index)}.sha256`;
      let expectedHash;
      try { expectedHash = await readFile(checksumFile, "utf8"); }
      catch (error) {
        // Uploads accepted before checksum sidecars were introduced already had
        // their request hash checked. Preserve those resumable files on upgrade.
        if (error.code !== "ENOENT" || asset.checksumVersion === 1) throw error;
        expectedHash = crypto.createHash("sha256").update(chunk).digest("hex");
        await writeFile(checksumFile, expectedHash);
      }
      if (crypto.createHash("sha256").update(chunk).digest("hex") !== expectedHash) throw new Error("An upload chunk is corrupt; remove this upload and select the original file again.");
      await handle.writeFile(chunk);
    }
  } finally { await handle.close(); }
}
export async function publishOutput(temporary, destination) { await rename(temporary, destination); }
export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return false;
  let start, end;
  if (!match[1]) { const suffix = Number(match[2]); if (!suffix) return false; start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return false;
  return { start, end };
}
