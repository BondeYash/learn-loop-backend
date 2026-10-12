import { createHash, randomUUID } from "node:crypto";
import ExamNotificationCache from "../models/ExamNotificationCache.js";

export const EXAM_FEED_ID = "parse-exam-notifications-v1";
export const EXAM_REFRESH_MS = 12 * 60 * 60 * 1000;
const MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SCRAPER = "c0f29a36-31f9-4da4-aeb3-63d34d3ca574";
const SOURCE = { name: "SarkariResult.com.cm", url: "https://sarkariresult.com.cm/", via: "Parse" };

function providerError(code, retryAt) {
  return Object.assign(new Error("Exam notification source unavailable"), { code, retryAt });
}

function plainText(value) {
  if (typeof value !== "string") return "";
  const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
  return value.slice(0, 4000).replace(/&#(x[0-9a-f]+|\d+);|&([a-z]+);/gi, (whole, numeric, name) => {
    if (!numeric) return named[name.toLowerCase()] ?? whole;
    const code = numeric[0].toLowerCase() === "x" ? parseInt(numeric.slice(1), 16) : Number(numeric);
    return code > 31 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : " ";
  }).replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

function sourceUrl(value) {
  try {
    if (typeof value !== "string" || value.length > 2000) return null;
    const url = new URL(value);
    if (url.protocol !== "https:" || !["sarkariresult.com.cm", "www.sarkariresult.com.cm"].includes(url.hostname) || url.username || url.password || url.port || url.pathname === "/") return null;
    url.search = ""; url.hash = ""; url.hostname = "sarkariresult.com.cm";
    return url.href;
  } catch { return null; }
}

function publicationDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null;
  const day = value.slice(0, 10), date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day ? day : null;
}

export function normalizeExamNotifications(payload) {
  if (!payload || typeof payload !== "object" || payload.error || (payload.status && payload.status !== "success")) throw providerError("invalid_response");
  const rows = payload.data?.posts ?? payload.posts;
  if (!Array.isArray(rows) || rows.length > 100) throw providerError("invalid_response");
  const seen = new Set(), notices = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const title = plainText(row.title), url = sourceUrl(row.link);
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    notices.push({ id: createHash("sha256").update(url).digest("hex").slice(0, 24), title, url, publishedOn: publicationDate(row.date) });
  }
  if (rows.length && !notices.length) throw providerError("invalid_response");
  return notices.sort((a, b) => (b.publishedOn || "").localeCompare(a.publishedOn || "")).slice(0, 20);
}

async function readBoundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw providerError("invalid_response");
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512 * 1024) throw providerError("invalid_response");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function fetchExamNotifications({ env = process.env, fetchProvider = fetch, now = Date.now } = {}) {
  const scraper = env.PARSE_SCRAPER_ID?.trim() || DEFAULT_SCRAPER;
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(scraper)) throw providerError("configuration");
  // Fixed host, endpoint and first-page category. Visitors cannot choose URLs,
  // pagination or searches that would spend more credits. No automatic retries.
  const url = `https://api.parse.bot/scraper/${scraper}/list_posts?page=1&category=latest-job`;
  const response = await fetchProvider(url, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { "X-API-Key": env.PARSE_API_KEY.trim(), Accept: "application/json" },
  });
  if (!response.ok) {
    const retry = response.headers.get("retry-after");
    const retryAt = retry && (/^\d+$/.test(retry) ? now() + Number(retry) * 1000 : Date.parse(retry));
    await response.body?.cancel();
    throw providerError([401, 403].includes(response.status) ? "configuration" : response.status === 402 ? "credits" : response.status === 429 ? "rate_limit" : "unavailable", Number.isFinite(retryAt) ? retryAt : undefined);
  }
  return normalizeExamNotifications(await readBoundedJson(response));
}

export function createExamNotificationService({ env = process.env, model = ExamNotificationCache, fetchProvider = fetch, now = Date.now, log = (code) => console.warn(`Exam notifications: ${code}`) } = {}) {
  let inFlight;
  const read = () => model.findById(EXAM_FEED_ID).lean();
  const view = (doc, enabled = true) => {
    const age = doc?.fetchedAt ? now() - new Date(doc.fetchedAt).getTime() : Infinity;
    const visible = age <= MAX_STALE_MS;
    return {
      enabled,
      status: !enabled ? "disabled" : !visible ? "unavailable" : age >= EXAM_REFRESH_MS || doc.lastError ? "stale" : "ready",
      notices: visible ? (doc.notices || []).map(({ id, title, url, publishedOn }) => ({ id, title, url, publishedOn })) : [],
      updatedAt: doc?.fetchedAt ? new Date(doc.fetchedAt).toISOString() : null,
      source: SOURCE,
    };
  };
  const refresh = async () => {
    try {
      await model.updateOne({ _id: EXAM_FEED_ID }, { $setOnInsert: { nextAttemptAt: new Date(0), notices: [] } }, { upsert: true });
    } catch (error) { if (error.code !== 11000) throw error; }
    const startedAt = now(), attemptId = randomUUID();
    const claimed = await model.findOneAndUpdate({ _id: EXAM_FEED_ID, nextAttemptAt: { $lte: new Date(startedAt) } }, { $set: { nextAttemptAt: new Date(startedAt + EXAM_REFRESH_MS), attemptId } }, { new: true }).lean();
    if (!claimed) return read();
    try {
      const notices = await fetchExamNotifications({ env, fetchProvider, now });
      return await model.findOneAndUpdate({ _id: EXAM_FEED_ID, attemptId }, { $set: { notices, fetchedAt: new Date(now()), lastError: "" } }, { new: true }).lean();
    } catch (error) {
      const code = ["configuration", "credits", "rate_limit", "invalid_response"].includes(error.code) ? error.code : "unavailable";
      log(code);
      // Keep the previous successful feed. Even failed/crashed refreshes consume
      // the shared attempt window, so retries/restarts cannot exhaust a free plan.
      const changes = { lastError: code };
      if (error.retryAt > startedAt + EXAM_REFRESH_MS) changes.nextAttemptAt = new Date(Math.min(error.retryAt, startedAt + 30 * 24 * 60 * 60 * 1000));
      return model.findOneAndUpdate({ _id: EXAM_FEED_ID, attemptId }, { $set: changes }, { new: true }).lean();
    }
  };
  const startRefresh = () => {
    if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
    return inFlight;
  };
  return {
    async get() {
      if (!env.PARSE_API_KEY?.trim()) return view(null, false);
      try {
        const doc = await read();
        if (doc?.nextAttemptAt > new Date(now())) return view(!doc.fetchedAt && inFlight ? await inFlight : doc);
        if (doc?.fetchedAt) {
          void startRefresh().catch(() => log("cache_unavailable"));
          return view(doc);
        }
        return view(await startRefresh());
      } catch { log("cache_unavailable"); return view(null); }
    },
  };
}

export const examNotificationService = createExamNotificationService();
