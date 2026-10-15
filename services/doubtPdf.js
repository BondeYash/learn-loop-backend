import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { chunkPages } from "./doubtRetrieval.js";
export function extractDoubtPdf(bytes) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: bytes, resourceLimits: { maxOldGenerationSizeMb: 192 }, stdout: true, stderr: true });
    let settled = false;
    const finish = result => {
      if (settled) return; settled = true; clearTimeout(timer); void worker.terminate();
      if (result?.chunks?.length) resolve(result); else reject(new Error(result?.error || "PDF text extraction could not finish. Try a smaller, text-based PDF."));
    };
    const timer = setTimeout(() => finish({ error: "PDF text extraction timed out. Split the PDF into smaller files and retry." }), 60000);
    worker.once("message", finish); worker.once("error", () => finish()); worker.once("exit", () => finish());
    worker.stdout.resume(); worker.stderr.resume();
  });
}
if (!isMainThread) {
  try {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({ data: new Uint8Array(workerData), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, enableXfa: false, verbosity: 0 });
    const pdf = await task.promise, pages = [];
    if (pdf.numPages > 500) throw new Error("Split PDFs longer than 500 pages before uploading.");
    for (let page = 1; page <= pdf.numPages; page++) {
      const value = await pdf.getPage(page), content = await value.getTextContent();
      pages.push(content.items.map(item => typeof item.str === "string" ? item.str + (item.hasEOL ? "\n" : " ") : "").join(""));
      value.cleanup();
    }
    const result = chunkPages(pages); await task.destroy(); parentPort.postMessage(result);
  } catch (error) { parentPort.postMessage({ error: /^(No searchable|This PDF|Split PDF)/.test(error.message) ? error.message : "PDF text extraction could not finish. Try a smaller, text-based PDF." }); }
}
