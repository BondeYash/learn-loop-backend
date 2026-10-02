import sharp from "sharp";
import { createHash } from "node:crypto";
import { PutObjectCommand, HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { r2Client } from "./videoObjectStore.js";
import ApiError from "../utils/ApiError.js";

export const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;
sharp.cache(false);
sharp.concurrency(1);
export async function prepareThumbnail(bytes) {
  if (!bytes?.length || bytes.length > MAX_THUMBNAIL_BYTES) throw new ApiError(413, "Choose a JPEG, PNG or WebP image up to 5 MB.");
  try {
    const image = sharp(bytes, { limitInputPixels: 16000000, failOn: "warning", animated: false });
    const info = await image.metadata();
    if (!["jpeg", "png", "webp"].includes(info.format) || (info.pages || 1) !== 1 || !info.width || !info.height) throw new Error("Unsupported image");
    // Decode the full input, strip metadata and normalize a bounded card image.
    const result = await image.rotate().resize(1200, 675, { fit: "cover", withoutEnlargement: true }).webp({ quality: 82 }).timeout({ seconds: 8 }).toBuffer({ resolveWithObject: true });
    return { bytes: result.data, width: result.info.width, height: result.info.height, sha256: createHash("sha256").update(result.data).digest("hex") };
  } catch { throw new ApiError(422, "This image cannot be decoded. Choose a valid, still JPEG, PNG or WebP image up to 16 megapixels."); }
}
export function courseThumbnailStore(client = r2Client()) {
  return {
    async upload(thumbnail, image) {
      await client.send(new PutObjectCommand({ Bucket: thumbnail.storageBucket, Key: thumbnail.objectKey, Body: image.bytes, ContentLength: image.bytes.length, ContentType: "image/webp", CacheControl: "private, no-store", Metadata: { sha256: image.sha256 } }), { abortSignal: AbortSignal.timeout(30000) });
      const head = await client.send(new HeadObjectCommand({ Bucket: thumbnail.storageBucket, Key: thumbnail.objectKey }), { abortSignal: AbortSignal.timeout(10000) });
      if (head.ContentLength !== image.bytes.length || head.ContentType !== "image/webp" || head.Metadata?.sha256 !== image.sha256) throw new ApiError(503, "Image storage confirmation failed. Please retry.");
    },
    async read(thumbnail) {
      const object = await client.send(new GetObjectCommand({ Bucket: thumbnail.storageBucket, Key: thumbnail.objectKey }), { abortSignal: AbortSignal.timeout(10000) });
      if (object.ContentType !== "image/webp" || object.ContentLength !== thumbnail.size || object.ContentLength > MAX_THUMBNAIL_BYTES) { object.Body?.destroy?.(); throw new ApiError(503, "Course image is temporarily unavailable."); }
      return object.Body;
    },
  };
}
