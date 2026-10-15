// Readiness is separate from publication: pausing the service or losing its
// configuration must never reset an admin's saved publication choice.
export function doubtReadiness({ enabled, configured, documents }) {
  if (!enabled) return { code: "paused", message: "Doubt Dost is paused by the platform. Your chat and published PDFs are still saved." };
  if (!configured) return { code: "service_unavailable", message: "Doubt Dost is temporarily unavailable. Your course PDFs are still saved. Please contact your instructor." };
  if (documents.some(doc => doc.status === "ready" && doc.searchVersion === 1 && doc.published)) return { code: "ready", message: "Your course PDFs are ready. Ask your doubt below." };
  const preparing = doc => ["uploading", "queued", "indexing"].includes(doc.status) || doc.status === "ready" && doc.searchVersion !== 1;
  const indexing = { code: "indexing", message: "Your course PDFs are being prepared for search. Published PDFs stay published, and this chat will unlock automatically when preparation finishes." };
  if (documents.some(doc => doc.published && preparing(doc))) return indexing;
  if (documents.some(doc => doc.published && doc.status === "failed")) return { code: "indexing_failed", message: "The published course PDFs could not finish processing. Your instructor needs to retry indexing; publication is still saved." };
  if (documents.some(doc => doc.status === "ready" && doc.searchVersion === 1)) return { code: "awaiting_publication", message: "The course PDFs are indexed and waiting to be published. Ask your instructor to publish them to Doubt Dost." };
  if (documents.some(preparing)) return indexing;
  if (documents.some(doc => doc.status === "failed")) return { code: "indexing_failed", message: "The course PDFs could not finish processing. Your instructor needs to retry indexing." };
  return { code: "no_material", message: "No course PDFs have been published to Doubt Dost yet. Ask your instructor to add and publish the course material." };
}
