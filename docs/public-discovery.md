# Public course discovery — Stage 1

LessonLoop is a government-exam learning platform. CCC is the owner's first ready offering; the catalog uses actual course/category data and does not invent additional inventory, pricing, credentials or results. No production course was changed or made public by this release.

## Owner workflow and privacy

Existing and new courses default to `visibility: private`. Legacy documents missing this field also stay out of anonymous discovery. An owner/admin must deliberately choose Public, provide the public details and publish the course. Saving Public on an already published course opens its public page immediately. Publication also retains the current signed-in catalog behavior: every student can browse published course metadata, while full lessons, PDFs and progress require an instructor assignment or explicit public enrollment, plus any required verified payment.

Public course information consists of the authored title, description, exam/category, summary, audience, language, level, INR price, requirements/outcomes, curriculum titles, cover and explicitly entered public instructor/contact/policy fields. Account names, bios and email addresses are never copied into the public profile. URLs must use HTTPS without credentials; the public response also clamps invalid stored links. Plain text is escaped by React.

Choose at most one `previewLesson` from the course: a text lesson containing text, or a ready private-R2 video whose asset belongs to that exact course and lesson. Old per-lesson `isPreview` values do not grant anonymous access. Other lesson bodies, PDFs, account identifiers and private object metadata never enter public DTOs. Owners can create/edit text samples in the curriculum. Deleting a selected lesson/module clears its selection.

## Anonymous API

- `GET /api/public/courses`: bounded pagination, escaped literal search over title/exam/summary and optional category ID. Categories come only from published public inventory.
- `GET /api/public/courses/:id`: ID or slug, public metadata and curriculum outline without lesson IDs/content/media.
- `GET /api/public/courses/:id/preview`: only the selected text body or short-lived signed video ticket.
- `GET /api/public/courses/:id/thumbnail`: private stored cover streamed through the API for a public published course.

All require `visibility: public`, `isPublished: true`, no archive, and private/no-store response headers. Reverting visibility, hiding or archiving stops fresh sample/image requests. Samples and covers recheck publication after awaiting storage. Previously issued signed video URLs remain bearer credentials until expiry; downloaded bytes cannot be revoked. This is deliberately shared sample content, not full-course access or DRM.

## Verification and rollout

`tests/publicCatalog.test.js` exercises anonymous/private/draft/archive/legacy exclusion, exact pricing, filters, DTO redaction, ignored legacy preview flags, sample ownership/readiness, protected media/PDF denial, text editing/deletion, unsafe links and retraction races. It uses disposable local MongoDB plus HTTP and mocked storage. Existing assignment, thumbnail, progress, account and mocked test/live payment regressions are also run. The payment test helper now distinguishes a published unassigned metadata page (200 with locked outline) from an unpublished course (403), matching the previously added signed-in browsing behavior.

Stage 1 verification: all 97 backend tests passed in the isolated full suite, including six public-catalog checks. The focused mocked payment suite passed all 31 checks in test/live modes. Syntax checks and `git diff --check` passed. No live Checkout request, production enrollment or media mutation was used for these checks.

Deploy the backend commit before or with the frontend. No new secrets, Stripe settings, storage policy, service or migration is required. The public catalog is honestly empty until an owner opts in. Verify deployed `/api/public/courses` returns JSON with no-store headers and that known private/draft IDs remain unavailable. A public CCC launch needs the owner's actual description, language, final price, public teaching/support details and selected sample. This release does not enter those details or publish synthetic fixtures.

Self-service public enrollment is implemented in [Stage 2](public-enrollment.md). Assessments/practical work and consent/attribution remain later stages. Existing live Stripe Checkout 400 diagnostics are unresolved; mocked payment regression success does not establish live payment readiness. Anonymous rate limits still share the existing socket/edge IP budget until the real proxy topology is verified; no trust-proxy change was made.
