import { PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { r2Client } from "./videoObjectStore.js";
import ApiError from "../utils/ApiError.js";

export function courseNoteStore(client = r2Client(), sign = getSignedUrl) {
  return {
    async upload(note, bytes) {
      await client.send(new PutObjectCommand({ Bucket: note.storageBucket, Key: note.objectKey, Body: bytes, ContentLength: bytes.length, ContentType: "application/pdf", CacheControl: "private, no-store", Metadata: { sha256: note.sha256 } }), { abortSignal: AbortSignal.timeout(45000) });
      const head = await client.send(new HeadObjectCommand({ Bucket: note.storageBucket, Key: note.objectKey }), { abortSignal: AbortSignal.timeout(10000) });
      if (head.ContentLength !== bytes.length || head.ContentType !== "application/pdf" || head.Metadata?.sha256 !== note.sha256) throw new ApiError(503, "PDF storage verification failed. Please retry.");
    },
    async link(note, download) {
      const url = await sign(client, new GetObjectCommand({ Bucket: note.storageBucket, Key: note.objectKey, ResponseContentType: "application/pdf", ResponseContentDisposition: `${download ? "attachment" : "inline"}; filename="${note.filename}"`, ResponseCacheControl: "private, no-store" }), { expiresIn: 300 });
      return { url, expiresAt: Date.now() + 300000 };
    },
    async remove(note) {
      await client.send(new DeleteObjectCommand({ Bucket: note.storageBucket, Key: note.objectKey }), { abortSignal: AbortSignal.timeout(10000) });
    },
  };
}
