import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2Client } from "./videoObjectStore.js";
import { courseNoteStore } from "./courseNoteStore.js";
import { MAX_PDF_BYTES } from "./pdfValidation.js";
export function doubtStorage() {
  const client = r2Client();
  return { ...courseNoteStore(client), async read(doc) {
    const result = await client.send(new GetObjectCommand({ Bucket: doc.storageBucket, Key: doc.objectKey }), { abortSignal: AbortSignal.timeout(45000) });
    if (result.ContentLength !== doc.size || result.ContentLength > MAX_PDF_BYTES) throw new Error("Invalid knowledge base object length");
    const parts = []; let length = 0;
    const timer = setTimeout(() => result.Body.destroy?.(new Error("Knowledge base read timed out")), 45000);
    try {
      for await (const chunk of result.Body) { length += chunk.length; if (length > MAX_PDF_BYTES) { result.Body.destroy?.(); throw new Error("Knowledge base object too large"); } parts.push(chunk); }
      return Buffer.concat(parts);
    } finally { clearTimeout(timer); }
  } };
}
