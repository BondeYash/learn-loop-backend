import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import ApiError from "../utils/ApiError.js";

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
const invalid = "Upload a valid, unencrypted PDF with 1–500 pages, up to 10 MB, without scripts or embedded files.";
let parsers = 0;
export function safePdfName(value) {
  const basename = String(value).split(/[\\/]/).pop().replace(/\.pdf$/i, "");
  return `${basename.replace(/[^a-zA-Z0-9 _.-]/g, "_").replace(/^\.+/, "").trim().slice(0, 100) || "course-notes"}.pdf`;
}
export function validatePdf(bytes) {
  if (!bytes?.length || bytes.length > MAX_PDF_BYTES || !/^%PDF-(1\.[0-7]|2\.0)/.test(bytes.subarray(0, 9).toString("ascii")) || !/%%EOF\s*$/.test(bytes.subarray(-1024).toString("latin1"))) return Promise.reject(new ApiError(422, invalid));
  if (parsers >= 2) return Promise.reject(new ApiError(429, "PDF validation is busy. Please retry shortly."));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: bytes, resourceLimits: { maxOldGenerationSizeMb: 128 }, stdout: true, stderr: true });
    parsers++;
    let settled = false;
    const finish = (pages) => { if (settled) return; settled = true; parsers--; clearTimeout(timer); worker.terminate(); if (pages) resolve(pages); else reject(new ApiError(422, invalid)); };
    const timer = setTimeout(() => finish(), 8000);
    worker.once("message", finish);
    worker.once("error", () => finish());
    worker.once("exit", () => finish());
    // Discard parser diagnostics; never log uploaded content.
    worker.stdout.resume(); worker.stderr.resume();
  });
}
if (!isMainThread) {
  try {
    const { PDFDocument, PDFDict, PDFArray, PDFName } = await import("pdf-lib");
    const pdf = await PDFDocument.load(workerData, { throwOnInvalidObject: true, updateMetadata: false });
    const seen = new Set();
    const inspect = (value) => {
      if (!value || seen.has(value)) return;
      seen.add(value);
      if (value instanceof PDFDict) {
        for (const [key, item] of value.entries()) {
          if (["JS", "JavaScript", "OpenAction", "AA", "EmbeddedFiles", "EF", "RichMedia"].includes(key.decodeText())) throw new Error("Active content");
          if (key.decodeText() === "S" && item instanceof PDFName && ["JavaScript", "Launch", "Rendition", "SubmitForm", "ImportData"].includes(item.decodeText())) throw new Error("Active action");
          inspect(item);
        }
      } else if (value instanceof PDFArray) value.asArray().forEach(inspect);
      else if (value.dict instanceof PDFDict) inspect(value.dict);
    };
    for (const [, object] of pdf.context.enumerateIndirectObjects()) inspect(object);
    const pages = pdf.getPages().length;
    parentPort.postMessage(pages > 0 && pages <= 500 ? pages : null);
  } catch { parentPort.postMessage(null); }
}
