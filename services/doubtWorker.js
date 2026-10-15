import crypto from "node:crypto";
import { DoubtDocument, DoubtKnowledgeBase, DoubtUsage } from "../models/DoubtDost.js";
import Course from "../models/Course.js";
import { doubtSettings, reserveUsage, monthKey } from "./doubtUsage.js";
import { doubtProvider, providerConfigured } from "./doubtProvider.js";
import { doubtStorage } from "./doubtStorage.js";
const leaseDate = () => new Date(Date.now() + 180000);
export async function ensureDoubtStore(course, provider) {
  try { await DoubtKnowledgeBase.updateOne({ course }, { $setOnInsert: { course } }, { upsert: true }); }
  catch (e) { if (e.code !== 11000) throw e; }
  const existing = await DoubtKnowledgeBase.findOne({ course });
  if (existing.removing) throw new Error("Knowledge base is being removed");
  if (existing.storeName) return existing;
  const claimed = await DoubtKnowledgeBase.findOneAndUpdate({ course, removing: false, storeName: { $exists: false }, $or: [{ leaseUntil: { $lt: new Date() } }, { leaseUntil: null }] }, { leaseUntil: leaseDate() }, { new: true });
  if (!claimed) throw new Error("Knowledge base is being prepared");
  let name;
  try { name = await provider.createStore(course); }
  catch (e) { await DoubtKnowledgeBase.updateOne({ _id: claimed._id, leaseUntil: claimed.leaseUntil }, { $unset: { leaseUntil: 1 } }); throw e; }
  return DoubtKnowledgeBase.findOneAndUpdate({ _id: claimed._id, leaseUntil: claimed.leaseUntil }, { storeName: name, $unset: { leaseUntil: 1 } }, { new: true });
}

export async function processDoubtJob({ provider = doubtProvider(), storage, configured = providerConfigured() } = {}) {
  if (!configured) return false;
  const now = new Date(), settings = await doubtSettings();
  const doc = await DoubtDocument.findOneAndUpdate({ status: { $in: settings.enabled ? ["queued", "indexing", "removing"] : ["indexing", "removing"] }, $and: [{ $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }] }, { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] }] }, { leaseUntil: leaseDate() }, { new: true, sort: { updatedAt: 1 } });
  if (!doc) {
    const obsolete = await DoubtKnowledgeBase.findOne({ removing: true, $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }] });
    if (obsolete && !await DoubtDocument.exists({ course: obsolete.course })) {
      if (obsolete.storeName) { try { await provider.removeStore(obsolete.storeName); } catch { return false; } }
      await DoubtKnowledgeBase.deleteOne({ _id: obsolete._id, removing: true });
      await DoubtUsage.deleteOne({ _id: `course:${obsolete.course}` });
      return true;
    }
    return false;
  }
  const filter = { _id: doc._id, leaseUntil: doc.leaseUntil, status: doc.status };
  try {
    storage ||= doubtStorage();
    const course = await Course.findById(doc.course);
    if (doc.status === "removing" || !course) {
      if (doc.operationName && !doc.providerDocument) {
        let operation;
        try { operation = await provider.operation(doc.operationName); }
        catch (e) { if (e.providerStatus !== 404) throw e; operation = { done: true }; }
        if (!operation.done && !operation.error) { await DoubtDocument.updateOne(filter, { leaseUntil: null, nextAttemptAt: new Date(Date.now() + 15000) }); return true; }
        const name = operation.response?.documentName || operation.response?.document?.name || operation.response?.name;
        if (name?.includes("/documents/")) doc.providerDocument = name;
      }
      if (doc.providerDocument) await provider.removeDocument(doc.providerDocument);
      else {
        const kb = await DoubtKnowledgeBase.findOne({ course: doc.course });
        if (kb?.storeName) { const remote = await provider.findDocument(kb.storeName, doc._id); if (remote) await provider.removeDocument(remote.name); }
      }
      await storage.remove(doc);
      const removed = await DoubtDocument.deleteOne(filter);
      if (removed.deletedCount) await Promise.all([DoubtUsage.updateOne({ _id: "storage" }, { $inc: { bytes: -doc.size } }), DoubtUsage.updateOne({ _id: `course:${doc.course}` }, { $inc: { documents: -1 } })]);
      return true;
    }
    if (doc.indexStartedAt && Date.now() - doc.indexStartedAt.getTime() > 30 * 60000) throw new Error("Indexing deadline exceeded");
    if (!doc.indexStartedAt) await DoubtDocument.updateOne(filter, { indexStartedAt: new Date() });
    if (course.archivedAt) { await DoubtDocument.updateOne(filter, { leaseUntil: null, nextAttemptAt: new Date(Date.now() + 300000) }); return true; }
    const kb = await ensureDoubtStore(doc.course, provider);
    let remote;
    if (doc.providerDocument) remote = await provider.document(doc.providerDocument);
    else if (doc.operationName) {
      const operation = await provider.operation(doc.operationName);
      if (operation.error) throw new Error("Provider indexing failed");
      if (operation.done) {
        const name = operation.response?.documentName || operation.response?.document?.name || operation.response?.name;
        remote = name?.startsWith(`${kb.storeName}/documents/`) ? await provider.document(name) : await provider.findDocument(kb.storeName, doc._id);
      }
    } else {
      // Recover an upload whose response was lost before its operation was saved.
      remote = await provider.findDocument(kb.storeName, doc._id);
      if (remote?.state?.includes("FAILED")) { await provider.removeDocument(remote.name); remote = null; }
      if (!remote) {
        const currentSettings = await doubtSettings();
        if (!currentSettings.enabled) { await DoubtDocument.updateOne(filter, { status: "queued", leaseUntil: null, nextAttemptAt: new Date(Date.now() + 60000) }); return true; }
        const bytes = await storage.read(doc);
        if (bytes.length !== doc.size || crypto.createHash("sha256").update(bytes).digest("hex") !== doc.sha256) throw new Error("PDF integrity mismatch");
        if (!doc.indexingCharged) {
          await reserveUsage(monthKey(), "pages", doc.pages, currentSettings.monthlyPages);
          await DoubtDocument.updateOne(filter, { indexingCharged: true });
        }
        const operation = await provider.upload(kb.storeName, doc, bytes);
        if (operation.error) throw new Error("Provider indexing failed");
        if (!operation.name && !operation.done) throw new Error("Missing indexing operation");
        const current = await DoubtDocument.findOne({ _id: doc._id, leaseUntil: doc.leaseUntil });
        if (current) await DoubtDocument.updateOne({ _id: doc._id, leaseUntil: doc.leaseUntil }, { status: current.status === "removing" ? "removing" : "indexing", operationName: operation.name, nextAttemptAt: new Date(Date.now() + 5000), leaseUntil: null });
        return true;
      }
    }
    if (remote && ["ACTIVE", "STATE_ACTIVE"].includes(remote.state)) {
      if (!remote.name?.startsWith(`${kb.storeName}/documents/`) || remote.displayName !== String(doc._id)) throw new Error("Unexpected indexed document");
      await DoubtDocument.updateOne(filter, { status: "ready", providerDocument: remote.name, error: "", leaseUntil: null, nextAttemptAt: null });
    } else if (remote?.state?.includes("FAILED")) throw new Error("Provider indexing failed");
    else await DoubtDocument.updateOne(filter, { status: "indexing", ...(remote?.name ? { providerDocument: remote.name } : {}), leaseUntil: null, nextAttemptAt: new Date(Date.now() + 15000) });
  } catch (e) {
    const removing = doc.status === "removing";
    await DoubtDocument.updateOne(filter, { ...(removing ? {} : { status: "failed" }), error: e.statusCode === 429 ? e.message : removing ? "Removal is pending. Retry removal after checking the AI service and storage." : "PDF indexing could not finish. Check the provider key, billing and PDF, then retry.", leaseUntil: null, nextAttemptAt: removing ? new Date(Date.now() + 300000) : null });
  }
  return true;
}
export function startDoubtWorker() {
  let stopped = false, running;
  const tick = () => { if (stopped || running || !providerConfigured()) return; running = processDoubtJob().catch(() => console.error("Doubt Dost background work needs attention")).finally(() => { running = null; }); };
  const timer = setInterval(tick, 5000); timer.unref(); tick();
  return async () => { stopped = true; clearInterval(timer); await running; };
}
