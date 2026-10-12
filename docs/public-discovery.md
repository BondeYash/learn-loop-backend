# Public course discovery

LessonLoop is a government-exam learning platform. The catalog uses actual course/category data and does not invent inventory, pricing, credentials or results. The owner requested that all active courses be discoverable. Active means published and unarchived; unpublished drafts and archived courses remain hidden. This change needs no production data migration.

## Owner workflow and privacy

Anonymous visitors can browse published, unarchived metadata regardless of `visibility`, including legacy records missing it. Existing and new courses still default to `visibility: private`: this controls assignment for free courses and disables anonymous samples. Every published paid course can be purchased without assignment. An owner/admin must deliberately choose Public to enable free self-enrollment and a selected sample. Saving Public on an already published course changes those policies immediately. Full lessons, PDFs, assessments and progress still require a verified purchase, or instructor assignment/public enrollment for free courses. No enrollment, account, price, payment setting or stored visibility value is changed by metadata discovery.

Public course information consists of the authored title, description, exam/category, summary, audience, language, level, INR price, requirements/outcomes, curriculum titles, cover and explicitly entered public instructor/contact/policy fields. Account names, bios and email addresses are never copied into the public profile. URLs must use HTTPS without credentials; the public response also clamps invalid stored links. Plain text is escaped by React.

Only an explicitly Public course can expose its selected `previewLesson`: a text lesson containing text, or a ready private-R2 video whose asset belongs to that exact course and lesson. Private courses hide even previously selected samples. Old per-lesson `isPreview` values do not grant anonymous access. Other lesson bodies, PDFs, account identifiers and private object metadata never enter public DTOs. Deleting a selected lesson/module clears its selection.

## Anonymous API

- `GET /api/public/courses`: bounded pagination, escaped literal search over title/exam/summary and optional category ID. Categories come from all published, unarchived inventory.
- `GET /api/public/courses/:id`: ID or slug, public metadata and curriculum outline without lesson IDs/content/media.
- `GET /api/public/courses/:id/preview`: only the selected text body or short-lived signed video ticket.
- `GET /api/public/courses/:id/thumbnail`: stored cover streamed through the API for any published, unarchived course.

Metadata and covers use `catalogCourseFilter`: `isPublished: true`, no archive. Samples and explicit free self-enrollment retain `publicCourseFilter`, which additionally requires `visibility: public`. Responses are private/no-store. Switching to Private stops fresh sample requests and free self-enrollment while retaining the metadata listing. Hiding or archiving stops fresh metadata and media requests. Samples and covers recheck their respective filters after awaiting storage. Previously issued signed sample URLs remain bearer credentials until expiry; downloaded bytes cannot be revoked.

Cards and detail DTOs include `availability: { enrollment: "purchase" | "public" | "assignment", ready: boolean }`. Readiness follows the existing publication/enrollment checks: a lesson or ready PDF note must exist and every video lesson must have a ready video. Paid courses return `purchase` for either visibility setting. Free public courses return `public`, and free private courses return `assignment`. Unready courses show preparation status. These informational reads never grant access, initiate checkout or save enrollment; server authorization remains decisive on every learning/payment request.

## Verification and rollout

`tests/publicCatalog.test.js` exercises private/legacy metadata inclusion, draft/archive exclusion, truthful readiness, exact pricing, filters, DTO redaction, ignored legacy preview flags, sample ownership/readiness, protected learning/PDF/assessment denial, self-enrollment and quote rejection for free assignment-only courses, text editing/deletion, unsafe links and retraction races. It uses disposable local MongoDB plus HTTP and mocked storage. Existing assignment, thumbnail, progress, account, assessment and mocked test/live payment regressions also run.

Current verification: all 135 backend tests passed in the isolated full suite, including public-catalog checks and test/live purchases without assignment. Syntax checks and `git diff --check` passed. No live checkout, production enrollment or media mutation was used for these checks.

Deploy the backend commit before or with the frontend. No new secrets, payment settings, storage policy, service or migration is required. Verify deployed `/api/public/courses` returns all published unarchived metadata with availability, and known draft/archive IDs remain unavailable. Private samples and free private self-enrollment remain denied. Unassigned students can quote and purchase paid courses; full paid content remains locked until verified capture. An empty catalog after this deployment means there are no published, unarchived courses; owner-authenticated inventory is needed to establish why.

Self-service public enrollment is implemented in [Stage 2](public-enrollment.md). Assessments/practical work and consent/attribution remain later stages. Razorpay is now integrated; see [setup](razorpay-payments.md). Synthetic payment tests do not establish live account readiness or actual charge delivery. Anonymous rate limits still share the existing socket/edge IP budget until the real proxy topology is verified; no trust-proxy change was made.
