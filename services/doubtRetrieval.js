import { DoubtChunk } from "../models/DoubtDost.js";
export const SEARCH_VERSION = 1;
const stop = new Set("a an the is are was were be been being to of in on at with and or for from this that what how why explain please me my course notes pdf kya hai hain ka ki ke ko se mein aur mujhe samjhao batao ye yeh woh होता होती है हैं का की के को से में और क्या कैसे क्यों समझाइए बताइए यह वह एक पर लिए".split(" "));
export function searchTerms(text) {
  const normalized = String(text).normalize("NFKC").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return [...new Set((normalized.match(/[\p{L}\p{M}\p{N}]+/gu) || []).filter(term => term.length > 1 && term.length <= 48 && !stop.has(term)).map(term => /^[a-z]{5,}$/.test(term) ? term.replace(/(?:ing|es|s)$/, "") : term))].slice(0, 160);
}
export function chunkPages(pages) {
  const chunks = []; let characters = 0, textPages = 0;
  for (const [page, value] of pages.entries()) {
    const text = value.replace(/\u0000/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length < 15) continue;
    textPages++; characters += text.length;
    if (text.length > 100000 || characters > 2000000) throw new Error("This PDF contains too much extracted text. Split it into smaller PDFs.");
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 1100, text.length);
      if (end < text.length) { const boundary = text.lastIndexOf(" ", end); if (boundary > start + 700) end = boundary; }
      const passage = text.slice(start, end).trim();
      chunks.push({ page: page + 1, position: chunks.length, text: passage, terms: searchTerms(passage), version: SEARCH_VERSION });
      if (chunks.length > 2500) throw new Error("This PDF needs too many search passages. Split it into smaller PDFs.");
      if (end === text.length) break;
      start = end - 140;
    }
  }
  if (!chunks.length) throw new Error("No searchable text was found. Upload a text-based PDF or run OCR on a scanned PDF first.");
  return { chunks, textPages };
}
export async function retrievePassages(course, documents, query) {
  const terms = searchTerms(query).slice(0, 40);
  if (!terms.length || !documents.length) return [];
  const matches = await DoubtChunk.aggregate([
    { $match: { course, document: { $in: documents.map(doc => doc._id) }, version: SEARCH_VERSION, terms: { $in: terms } } },
    { $addFields: { matches: { $size: { $setIntersection: ["$terms", terms] } } } },
    { $sort: { matches: -1, document: 1, page: 1, position: 1 } },
    { $limit: 30 },
    { $project: { text: 1, document: 1, page: 1, position: 1, terms: 1, matches: 1 } },
  ]).option({ maxTimeMS: 8000 });
  const frequency = new Map(terms.map(term => [term, matches.filter(chunk => chunk.terms.includes(term)).length]));
  const ranked = matches.map(chunk => ({ ...chunk, score: terms.reduce((sum, term) => sum + (chunk.terms.includes(term) ? Math.log(2 + matches.length / (frequency.get(term) || 1)) : 0), 0) })).sort((a, b) => b.score - a.score || a.position - b.position);
  // Keep the prompt small enough for the free tier's token limits and avoid
  // filling it with near-identical overlapping windows from the same page.
  const selected = [];
  for (const chunk of ranked) {
    if (selected.some(other => String(other.document) === String(chunk.document) && Math.abs(other.position - chunk.position) <= 1)) continue;
    selected.push(chunk); if (selected.length === 4) break;
  }
  return selected.map((chunk, index) => ({ id: `S${index + 1}`, document: chunk.document, page: chunk.page, text: chunk.text }));
}
