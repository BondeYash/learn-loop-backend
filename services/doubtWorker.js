import crypto from "node:crypto";
import { DoubtDocument, DoubtKnowledgeBase, DoubtChunk, DoubtUsage } from "../models/DoubtDost.js";
import Course from "../models/Course.js";
import { doubtSettings, reserveUsage, monthKey } from "./doubtUsage.js";
import { doubtStorage } from "./doubtStorage.js";
import { extractDoubtPdf } from "./doubtPdf.js";
import { SEARCH_VERSION } from "./doubtRetrieval.js";

export async function processDoubtJob({ storage, extract = extractDoubtPdf } = {}) {
  const now = new Date(), settings = await doubtSettings();
  const eligible = settings.enabled
    ? [{ status: { $in: ["queued", "indexing", "removing"] } }, { status: "ready", searchVersion: { $ne: SEARCH_VERSION } }]
    : [{ status: "removing" }];
  const doc = await DoubtDocument.findOneAndUpdate({ $and: [{ $or: eligible }, { $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }] }, { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] }] }, { leaseUntil: new Date(Date.now() + 180000) }, { new: true, sort: { updatedAt: 1 } });
  if (!doc) {
    const obsolete = await DoubtKnowledgeBase.findOne({ removing: true, storeName: { $exists: false } });
    if (obsolete && !await DoubtDocument.exists({ course: obsolete.course })) {
      await DoubtChunk.deleteMany({ course: obsolete.course });
      // Keep legacy store identifiers for manual deletion in Google AI Studio.
      // The Groq flow never sends requests to Gemini, including cleanup calls.
      await DoubtKnowledgeBase.deleteOne({ _id: obsolete._id, removing: true });
      await DoubtUsage.deleteOne({ _id: `course:${obsolete.course}` });
    }
    return false;
  }
  const filter = { _id: doc._id, leaseUntil: doc.leaseUntil, status: doc.status };
  try {
    storage ||= doubtStorage();
    const course = await Course.findById(doc.course);
    if (doc.status === "removing" || !course) {
      await storage.remove(doc); await DoubtChunk.deleteMany({ document: doc._id });
      const removed = await DoubtDocument.deleteOne(filter);
      if (removed.deletedCount) await Promise.all([DoubtUsage.updateOne({ _id: "storage" }, { $inc: { bytes: -doc.size } }), DoubtUsage.updateOne({ _id: `course:${doc.course}` }, { $inc: { documents: -1 } })]);
      return true;
    }
    if (course.archivedAt) { await DoubtDocument.updateOne(filter, { leaseUntil: null, nextAttemptAt: new Date(Date.now() + 300000) }); return true; }
    try { await DoubtKnowledgeBase.updateOne({ course: doc.course }, { $setOnInsert: { course: doc.course } }, { upsert: true }); }
    catch (error) { if (error.code !== 11000) throw error; }
    const bytes = await storage.read(doc);
    if (bytes.length !== doc.size || crypto.createHash("sha256").update(bytes).digest("hex") !== doc.sha256) throw new Error("PDF integrity mismatch");
    if (!doc.indexingCharged && doc.status !== "ready") {
      await reserveUsage(monthKey(), "pages", doc.pages, settings.monthlyPages);
      await DoubtDocument.updateOne(filter, { indexingCharged: true });
    }
    const { chunks, textPages } = await extract(bytes);
    // A concurrent removal must not resurrect either the document or its text.
    if (!await DoubtDocument.exists(filter)) return true;
    await DoubtChunk.deleteMany({ document: doc._id });
    await DoubtChunk.insertMany(chunks.map(chunk => ({ ...chunk, course: doc.course, document: doc._id })));
    await DoubtDocument.updateOne(filter, { status: "ready", searchVersion: SEARCH_VERSION, chunkCount: chunks.length, textPages, error: "", leaseUntil: null, nextAttemptAt: null });
  } catch (error) {
    const removing = doc.status === "removing";
    await DoubtDocument.updateOne(filter, { ...(removing ? {} : { status: "failed" }), error: error.statusCode === 429 ? error.message : removing ? "Removal is pending. Check private PDF storage and retry." : /^(No searchable|This PDF|Split PDF|PDF text extraction)/.test(error.message) ? error.message : "PDF indexing could not finish. Check private PDF storage and retry.", leaseUntil: null, nextAttemptAt: removing ? new Date(Date.now() + 300000) : null });
  }
  return true;
}
export function startDoubtWorker() {
  let stopped = false, running;
  const tick = () => { if (stopped || running) return; running = processDoubtJob().catch(() => console.error("Doubt Dost background work needs attention")).finally(() => { running = null; }); };
  const timer = setInterval(tick, 5000); timer.unref(); tick();
  return async () => { stopped = true; clearInterval(timer); await running; };
}
