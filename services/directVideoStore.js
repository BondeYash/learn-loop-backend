import { PutObjectCommand, GetObjectCommand, HeadObjectCommand, CopyObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2Client } from "./videoObjectStore.js";
import ApiError from "../utils/ApiError.js";
const boundedTTL = (value, fallback, maximum) => Math.min(maximum, Math.max(60, Number(value) || fallback));
export const uploadTTL = () => boundedTTL(process.env.UPLOAD_URL_TTL_SECONDS, 900, 3600);
export const playbackTTL = () => boundedTTL(process.env.PLAYBACK_URL_TTL_SECONDS, 300, 900);
export function mp4Header(bytes) {
  if (bytes.length < 16 || bytes.toString("ascii", 4, 8) !== "ftyp") return false;
  const brands = [];
  for (let i = 8; i + 4 <= Math.min(bytes.readUInt32BE(0), bytes.length); i += 4) if (i !== 12) brands.push(bytes.toString("ascii", i, i + 4));
  return !brands.includes("qt  ") && brands.some((brand) => /^(isom|iso[2-9]|mp4[12]|avc1|M4V )$/.test(brand));
}
export function directVideoStore(client = r2Client(), sign = getSignedUrl) {
  return {
    async uploadTicket(asset) {
      const expiresIn = uploadTTL();
      const headers = { "Content-Type": "video/mp4", "x-amz-meta-upload-id": String(asset._id) };
      const command = new PutObjectCommand({ Bucket: asset.storageBucket, Key: asset.uploadKey, ContentType: "video/mp4", Metadata: { "upload-id": String(asset._id) } });
      const url = await sign(client, command, { expiresIn, signableHeaders: new Set(["content-type", "x-amz-meta-upload-id"]), unhoistableHeaders: new Set(["x-amz-meta-upload-id"]) });
      return { url, headers, expiresAt: Date.now() + expiresIn * 1000 };
    },
    async finalize(asset, destination) {
      let head;
      try { head = await client.send(new HeadObjectCommand({ Bucket: asset.storageBucket, Key: asset.uploadKey })); }
      catch (e) { if ([404, 403].includes(e.$metadata?.httpStatusCode)) throw new ApiError(409, "No completed upload was found. Select the same MP4 to retry the transfer."); throw e; }
      if (head.ContentLength !== asset.size || head.ContentType !== "video/mp4" || head.Metadata?.["upload-id"] !== String(asset._id) || !head.ETag) throw new ApiError(422, "Uploaded file does not match this upload session. Select the original MP4 and retry.");
      const object = await client.send(new GetObjectCommand({ Bucket: asset.storageBucket, Key: asset.uploadKey, Range: "bytes=0-63", IfMatch: head.ETag }));
      const header = Buffer.from(await object.Body.transformToByteArray());
      if (!mp4Header(header)) throw new ApiError(422, "This file is not an accepted MP4 container. Convert it to H.264/AAC MP4 before uploading.");
      // Copy inside R2 to a key that has never had a signed PUT URL. Reusing an
      // unexpired upload link cannot overwrite a video after it becomes ready.
      await client.send(new CopyObjectCommand({ Bucket: asset.storageBucket, Key: destination, CopySource: `${asset.storageBucket}/${asset.uploadKey.split("/").map(encodeURIComponent).join("/")}`, CopySourceIfMatch: head.ETag, MetadataDirective: "REPLACE", ContentType: "video/mp4", CacheControl: "private, no-store", Metadata: { "upload-id": String(asset._id) } }));
      const saved = await client.send(new HeadObjectCommand({ Bucket: asset.storageBucket, Key: destination }));
      if (saved.ContentLength !== asset.size || saved.ContentType !== "video/mp4") throw new ApiError(503, "Storage confirmation failed. Please check the upload again.");
      return { outputSize: saved.ContentLength };
    },
    async cleanupIncoming(asset) {
      // Only temporary objects created by this new flow are eligible here.
      if (asset.uploadMode === "direct" && asset.uploadKey?.startsWith(`incoming/${asset._id}/`)) await client.send(new DeleteObjectCommand({ Bucket: asset.storageBucket, Key: asset.uploadKey }));
    },
    async playback(asset) {
      const expiresIn = playbackTTL();
      const url = await sign(client, new GetObjectCommand({ Bucket: asset.storageBucket, Key: asset.objectKey, ResponseContentType: "video/mp4", ResponseCacheControl: "private, no-store" }), { expiresIn });
      return { url, expiresAt: Date.now() + expiresIn * 1000 };
    },
  };
}
