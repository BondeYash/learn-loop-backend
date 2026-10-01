import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { S3Client, GetObjectCommand, HeadBucketCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { outputPath } from "./videoStorage.js";
let client;
export function storageProvider() {
  const provider = process.env.VIDEO_STORAGE_PROVIDER || "local";
  if (!["local", "r2"].includes(provider)) throw new Error("VIDEO_STORAGE_PROVIDER must be local or r2");
  return provider;
}
export function r2Client() {
  const required = ["R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing R2 configuration: ${missing.join(", ")}`);
  if (!/^[a-f0-9]{32}$/i.test(process.env.R2_ACCOUNT_ID)) throw new Error("R2_ACCOUNT_ID must be a Cloudflare account ID");
  if (!client) client = new S3Client({ region: "auto", endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY }, maxAttempts: 4, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
  return client;
}
export async function checkObjectStore() {
  if (storageProvider() === "r2") await r2Client().send(new HeadBucketCommand({ Bucket: process.env.R2_BUCKET }));
}
export async function persistVideo(asset) {
  if (asset.storageProvider !== "r2") return;
  const upload = new Upload({ client: r2Client(), queueSize: 2, partSize: 8 * 1024 * 1024, leavePartsOnError: false, params: { Bucket: asset.storageBucket, Key: asset.objectKey, Body: createReadStream(outputPath(asset)), ContentLength: (await stat(outputPath(asset))).size, ContentType: "video/mp4", CacheControl: "private, no-store" } });
  await upload.done();
}
export async function openVideo(asset, range, { client: providedClient } = {}) {
  if (asset.storageProvider === "r2") {
    const result = await (providedClient || r2Client()).send(new GetObjectCommand({ Bucket: asset.storageBucket, Key: asset.objectKey, ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) }));
    return result.Body;
  }
  return createReadStream(outputPath(asset), range || {});
}
export async function deleteStoredVideo(asset) {
  if (asset.storageProvider === "r2" && asset.objectKey) await r2Client().send(new DeleteObjectCommand({ Bucket: asset.storageBucket, Key: asset.objectKey }));
}
