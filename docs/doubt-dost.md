# Doubt Dost: Groq + local PDF retrieval

Doubt Dost uses Groq's `openai/gpt-oss-20b` model, private R2 originals and searchable text passages stored in MongoDB. Gemini is no longer called for indexing, answers or cleanup. There is no paid fallback or separate vector database.

## Deploy

1. Add `GROQ_API_KEY` to the Render backend and redeploy. Keep the Groq account on its Free plan. Never put the key in frontend variables, source control or a URL. Optional `GROQ_MODEL` supports `openai/gpt-oss-20b` (default), `openai/gpt-oss-120b` or `qwen/qwen3.8-27b`. The old `DOUBT_DOST_MODEL` setting is ignored.
2. Keep MongoDB and private R2 read/write/delete configuration. Exclude `knowledge/` originals from temporary-upload expiry. Node 22.13+ is required.
3. Existing ready PDFs are automatically indexed from their saved originals. Their publication flag and timestamp are preserved. During this one-time preparation, students see a preparation notice and open chats automatically recheck availability. No re-upload or re-publication is required for a successfully migrated PDF.
4. In Admin → Doubt Dost, select the exact course, upload text-based PDFs, wait for Indexed draft, preview a known question and publish approved material. Publication persists across sign-ins and restarts until explicitly unpublished/removed. The frontend asks for confirmation before unpublishing.
5. Verify a known question and its cited page using an entitled student account.

An old `GEMINI_API_KEY` is unused. Old Google File Search copies are **not automatically deleted** by this migration: after verifying Groq, delete the old stores through Google/provider administration if no longer needed. Legacy store identifiers remain in MongoDB for that cleanup; removing a document from the new app removes its R2 original and local passages, not its historical Google copy.

## PDFs and retrieval

The knowledge base is separate from course handouts. PDFs must be unencrypted, structurally valid, at most 10 MB and 500 pages, without scripts or embedded files. PDF.js extracts text in a worker thread with a memory limit and 60-second deadline. Page references come from the parser. Text is split into overlapping passages (1,100 characters, 140-character overlap), bounded to 2 million characters / 2,500 passages per file.

**Image-only/scanned PDFs need OCR before upload.** Empty extraction fails with a clear message; partially searchable files show how many pages contain text. The app does not invent answers from unreadable pages.

Search uses normalized English/Hindi terms, stop-word filtering and keyword overlap/ranking within the server-authorized course and ready, published documents. Up to four distinct passages are supplied to Groq. A Hindi question or search without a match can use one additional Groq call to generate bilingual search keywords; previous questions help resolve follow-ups. This is lexical retrieval, so unusual wording, spelling and cross-language matches can still be missed. Representative Hindi/Hinglish questions should be previewed.

The model returns JSON with an answer and passage citations. The server requires a completed response, known passage IDs and exact quotations from those passages. Invalid quotes, unknown/withdrawn documents, invalid pages or insufficient evidence produce a localized instructor-help response. This validates source membership and quotations, not every generated claim. Students should check citations.

Only questions, bounded recent history and selected passages are sent to Groq; full PDFs stay in R2 and extracted passages in MongoDB. Review [Groq's data policy](https://console.groq.com/docs/your-data) for the account in use.

## Access and reliability

Students must have course material access through payment or an instructor's payment waiver. Unpaid assignment alone does not grant access. Course access and session validity are checked after generation too. History is private to the student and admins, newest 30 turns, with a 90-day MongoDB TTL. Unpublishing/removal suppresses affected answers and source excerpts. Cited original PDFs use five-minute signed URLs.

Generation has a 45-second overall deadline, a 30-second timeout per Groq request and no automatic retry. The browser has an independent 60-second deadline, elapsed feedback and saved-answer recovery keyed to the original request ID. Read-only checks never trigger another AI generation. A lost HTTP response can be recovered from history without sending the question twice. Students retain the question after failures and can retry manually or review/send an instructor question draft.

The five-second worker uses persisted leases and resumes after a restart. Sleeping Render instances pause indexing until they wake. Removal hides material immediately, then removes R2 originals and MongoDB passages; storage failures retry after five minutes. Archived courses deny student access while retaining material.

## Free plan and application allowances

The [Groq Free plan limits](https://console.groq.com/docs/rate-limits) currently list 30 requests/minute, 1,000/day and 200,000 tokens/day for GPT-OSS 20B, with additional per-minute token limits. Limits are shared across the organization and can change. A bilingual rewrite may use a second request, and PDF context/history count as input tokens, so 1,000 requests is not a promise of 1,000 student answers. A 429 response shows a clear wait/instructor option; the app never silently upgrades plans.

Application defaults remain 500 answer attempts/month globally, 20/student/day, 1,000 locally indexed pages/month, 100 MB raw PDFs and 100 PDFs/course. Admins can change these under Usage controls. These are separate from Groq quotas and are not a currency cap. Usage persists in MongoDB and day/month boundaries use Asia/Kolkata. Attempts reaching reservation count even if no supported answer is returned. Replaying a request ID does not generate again.

Local indexing requires no model request and can finish while the Groq key is missing. Automatic conversion of an already indexed legacy PDF does not charge another local page allowance. Pausing AI answers also pauses new indexing; removal continues. No key is needed for local indexing/removal.

## Verification

Run `NODE_ENV=test CLIENT_URL=http://127.0.0.1:5186 node --test tests/doubt*.test.js` against a disposable MongoDB on `TEST_MONGO_PORT` (default 27018). Tests cover PDF text extraction, quotas, citations, private history, request replay, publication persistence/migration, access revocation, deadlines and cleanup. Provider responses and R2 are simulated.

The frontend's `tests/doubt_dost_e2e_browser.py` exercises real React, Express, MongoDB and PDF extraction with synthetic accounts/material and mocked Groq/R2. Its companion chat UI test covers slow responses, lost response recovery, themes and mobile layouts. No automated test spends live AI credits or verifies a production key. After deployment, use admin preview to confirm the configured Groq account/model accepts a real request.
