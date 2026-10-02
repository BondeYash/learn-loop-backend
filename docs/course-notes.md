# Simpler course creation and private PDF notes

The instructor flow is course details → content → assign students. The updated frontend requests a default **Lessons** module, so module creation is optional. New courses stay closed internally while content is prepared. **Assign course** validates readiness and opens assigned-student access in the same action. Ready lessons, PDFs or both can be shared; every video lesson must be ready. Existing courses and their access state are preserved without a bulk migration or automatic opening.

The existing publish endpoint remains for older clients and optional pause/reopen controls. Archive retains curriculum, assignments, progress and PDF records/objects. Restore closes student access until reviewed and deliberately reopened. Students do not receive unfinished video lessons or unfinished notes in their listings.

## PDF notes

Owners/admins can upload multiple course-level handouts. Other instructors and students cannot mutate them. Ownership is checked before receiving bytes and again after storage work. Fresh note links require a live session and assigned-student access to an active, available course, or course-owner/admin preview access. Every note lookup matches its course ID.

- Limit: 10 MiB per PDF, 1–500 pages, twenty notes per course. Unique database slots enforce the per-course count during concurrent requests. No global tenant storage budget is claimed.
- Bounded multipart uploads pass through the API to the existing private R2 bucket. PDFs do not receive browser-side signed PUT URLs or public storage access.
- Extension/MIME, actual header/trailer and parsed structure are checked. Encrypted documents and recognized scripts/launch actions/embedded files are rejected. Parsing uses workers with an eight-second deadline, a 128 MiB old-generation heap limit and at most two concurrent parsers/process. These controls are not antivirus or a total process-memory limit.
- Safe filenames are independent of server-chosen `notes/<course-id>/<note-id>.pdf` keys. Storage length, MIME and digest metadata are checked before readiness.
- An upload identifier and file digest make same-selection retries idempotent. Failed entries are hidden from students. After reload, remove a failed entry before selecting it again. Removal hides the note before deleting its object; failed deletion can be retried. Interrupted uploads can be retried/removed after the 90-second lease.
- **Open PDF** and **Download** request five-minute signed GET links with inline/attachment dispositions. PDF downloads are allowed. Issued URLs and received bytes cannot be immediately revoked.

Existing R2 credentials need read/write/delete permission on `notes/` as well as video prefixes. Preserve private bucket access and exact-origin GET CORS. Do not apply an expiry lifecycle to referenced `notes/` or `videos/` objects. No new mandatory environment variable, provider or destructive migration is required. Startup initializes new `CourseNote` indexes; normal collection/index permissions are needed.

## Rollout and checks

Deploy backend before the remaining frontend. Older clients retain their assignment/publication APIs. The new frontend needs note endpoints and readiness-aware assignment. A frontend-before-backend window can produce retryable endpoint errors. Keep archive/suspension enforcement in any rollback; preserve note records and referenced objects. Prefer a forward fix.

On 2026-10-02, 48 backend tests passed using disposable MongoDB/HTTP and legacy FFmpeg regression, with R2 mocked. Tests cover parser rejection, storage verification, owner/admin permission, other-instructor/unassigned/student denial, safe filenames, size limits, sharing, unfinished listing exclusion, upload retry, removal failure, archive/revocation and slot limits. Dependency audit reported zero known production vulnerabilities.

Frontend lint, eighteen auth/video/proxy checks and production build pass. Isolated Chrome checks verify creation, multiple notes, retry, assignment, student read actions, mobile themes, reduced motion, loading/error/empty-state recovery and video playback/renewal. These do not prove deployed R2/cookies, actual PDF viewers, all devices, assistive technology or concurrency. Hosted checks remain with the operator.

API: `GET/POST /api/courses/:id/notes`, `GET /api/courses/:id/notes/:noteId/url?download=true`, `DELETE /api/courses/:id/notes/:noteId`. Source: `courseNoteController.js`, `courseNoteStore.js`, `pdfValidation.js`, `noteUpload.js`, `CourseNote.js`, `courseReadiness.js`, `tests/courseNotes.test.js`.
