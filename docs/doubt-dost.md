# Doubt Dost

Doubt Dost answers course questions using an admin-managed PDF knowledge base. It uses Gemini File Search with `gemini-3.1-flash-lite`, private R2 originals, and MongoDB for documents, job leases, allowances and chat history. No vector database or additional npm dependency is required.

## Deployment and first use

1. Set `GEMINI_API_KEY` privately in the Render backend and redeploy. Never put it in frontend variables, source control or a URL. `DOUBT_DOST_MODEL` is optional; an override must support File Search.
2. Retain the existing MongoDB and private R2 configuration. The backend credential needs read, write and delete access for `knowledge/<course>/<document>.pdf` in the existing private bucket. Keep public bucket access disabled and exclude this prefix from temporary-upload lifecycle expiry.
3. Sign in as admin and open `/admin/doubt-dost` on the frontend. Select a course, upload PDFs, wait for “Indexed draft”, and test a question in the preview. Then choose “Publish to Doubt Dost”. Indexing does not publish a file automatically.
4. An entitled student opens their course and chooses “Meet Doubt Dost”. Paid enrollment and instructor-granted payment waivers use the existing course access rules. An unpaid assignment alone does not grant access.

The knowledge base is separate from course handouts; existing course PDFs and videos are not automatically sent to Google. Multiple PDFs can be selected; uploads run sequentially. Each PDF must be unencrypted, structurally valid, at most 10 MB and 500 pages, and contain no scripts or embedded files. The default is 100 PDFs per course, adjustable to 1,000. Pagination keeps large libraries manageable.

Only publish material approved for student access. Entitled students can open the original cited PDF using a five-minute signed link. A previously issued signed URL remains usable until expiry. Google processes the indexed files, questions and recent conversation context; use a billing-enabled project for proprietary material and review the provider's data terms. This deployment is intended for the adult users specified for the platform.

## Retrieval and answering

Each course has a separate managed File Search store using `gemini-embedding-2`. It supports text and scanned/image material; answer quality still depends on the original PDF. Upload display names and metadata use internal document IDs. Students never supply a store name, document filter or model.

The backend filters retrieval to ready, published documents in that student's course, limits retrieval to six chunks and includes at most three previous grounded turns. Hindi, English and Hinglish are supported. Output is capped at 1,200 tokens. The model is instructed to treat document contents as reference data and to abstain when evidence is insufficient.

Answers require provider grounding supports that refer to allowed documents. Missing citations, incomplete output or unauthorized sources produce a localized “ask your instructor” response instead of the generated answer. Page numbers are shown only when the provider supplies a valid page within that PDF. Scanned-image citations can open the source without a text excerpt. This validates source membership, not the correctness of every generated statement; admins should preview representative questions and students should check the material.

Course access and session validity are checked again after generation. Unpublishing or removing a PDF suppresses affected answers and excerpts in later chat reads. Students see only their own history and can rate answers. “Ask instructor” opens a private question draft for the student to review and explicitly send; it sends nothing automatically.

## Cost controls

Defaults are 500 answer requests per calendar month globally, 20 per student per day, 1,000 PDF pages indexed per month and 100 MB of raw PDF storage. Admin previews use the requesting admin's daily allowance and the global monthly allowance. Daily and monthly boundaries use Asia/Kolkata.

Counters are reserved atomically in MongoDB, so restarts do not reset them. Answer attempts that reach the allowance reservation count even if Google fails or no grounded answer is returned. There is no automatic generation retry. A repeated request ID replays its recorded result without another generation call; manual retry after a definitive error is a new attempt. One answer per account/course is allowed in flight. A per-account 20-request/minute limiter also applies.

Indexing pages are charged to the local allowance before uploading to Google. Failed uploads or manual indexing retries can consume additional provider usage; a retry starts another local page reservation when a fresh upload is needed. Identical PDF bytes in one course are deduplicated. Removing a PDF restores storage/document allowances after deletion is confirmed, but does not refund monthly answer/page usage.

These controls limit counts, not a guaranteed rupee spending cap. Scanned/image indexing and variable input/context sizes affect the bill. Managed retrieval/storage and embedding prices can change. Review the [Gemini pricing page](https://ai.google.dev/gemini-api/docs/pricing), [File Search guide](https://ai.google.dev/gemini-api/docs/file-search), [store API](https://ai.google.dev/api/file-search/file-search-stores) and [Gemini API terms](https://ai.google.dev/gemini-api/terms) before increasing allowances.

The admin “Allow AI answers and new indexing” switch stops new answers and new uploads to the provider. Already accepted indexing operations are still polled and removals continue. PDF intake can remain queued while paused. Removing the API key also prevents provider cleanup; restore the key to finish pending removal.

## Background work and retention

The API starts a five-second background worker with persisted leases. Queued uploads and accepted operations resume after a restart. A single API process is the recommended initial deployment. Render sleeping pauses work until the service wakes; this is not a separate always-on job service. Indexing has a 30-minute processing deadline and a manual retry action. Generic errors hide provider details and credentials.

Removal hides the document immediately and then deletes its provider copy and R2 original. Failed removal stays queued and retries after five minutes. Purging a course deletes chat records and preserves PDF references until cleanup finishes; a removed course's empty provider store is then deleted. Archived courses retain their private material and deny student access.

Chat records have a 90-day MongoDB TTL index; physical deletion is asynchronous. The student API returns the most recent 30 turns. The model sees at most the latest three eligible answered turns. Usage records for days/months expire after 100 days; cumulative storage counters remain until adjusted by cleanup. Backups and provider retention follow their own configured policies.

## Verification

`node --test tests/doubtDost.test.js` uses an isolated disposable database on `TEST_MONGO_PORT` (default 27018). It covers access, PDF drafts/publication, private history, citations, request replay, budgets, revocation during generation, errors and cleanup. It mocks Gemini/R2; no live provider acceptance or answer-quality claim follows from these tests.

`tests/doubtBrowserFixture.js` is a disposable HTTP fixture used by the frontend's `tests/doubt_dost_e2e_browser.py`. The browser test exercises real React, Express and MongoDB with only Gemini/R2 simulated, including PDF upload, preview, publication, student source viewing, Hindi/Hinglish, failures, instructor handoff, mobile layouts and themes.

After deployment, upload one representative real PDF, preview a question with a known answer, inspect its citation, publish it and verify using an entitled student account. Check Render for indexing failures and Google's usage dashboard for billing/model access. A configured key alone does not verify provider acceptance.
