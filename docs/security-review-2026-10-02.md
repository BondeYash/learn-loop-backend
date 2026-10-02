# Production/security review — 2026-10-02

Scope: source after admin/course CRUD, simpler readiness-aware assignment, private PDF notes, student video deterrents/watermark and frontend skeletons. Target: 10–100 enrolled students, not proven 100 simultaneous streams. This is a code/document review, not a penetration test or hosted certification. No live checks, provider-setting changes, secret inspection or production-data mutations were performed. Only the requested features were implemented; findings below remain follow-ups.

**Labels:** confirmed = present/absent in inspected source; inferred = impact/race follows from code but was not reproduced; unknown = requires deployed/account evidence. Severity is impact; P0/P1/P2 is recommended order. Paths below are backend-relative unless prefixed `frontend/`.

## Implemented and locally verified

Student-only public registration, admin provisioning, expiring temporary passwords/private replacement, server role/ownership/assignment checks, account suspension and session-generation invalidation are implemented. Bootstrap is a protected interactive operator CLI with no public route, default password or password arguments. Cookie sessions have random tokens, hashed DB storage, expiry checks, HttpOnly, production Secure, SameSite=Lax and `/api` scope. Password-reset redemption is atomic, expiring and single-use. (`services/authService.js`, `services/sessionService.js`, `middleware/auth.js`, `scripts/bootstrap-admin.js`, `controllers/adminController.js`.)

Archive closes access through one course document, preserves related records/media, and restores closed until deliberately reopened. Publication/archive race tests pass. Admin DTOs exclude credentials/storage keys; auditing persists intent/outcome. The same-origin Worker preserves cookies/no-store and strips claimed forwarding chains. (`services/courseService.js`, `middleware/adminAudit.js`, frontend `worker/proxy.js`.)

Video links check current access/readiness, use short TTLs and renew in the player. Ready video keys never have signed PUT URLs. Download UI deterrents and a partial learner overlay are implemented, with wrapper fullscreen where supported. Assignment now combines readiness validation and opening access. PDFs use private storage, bounded size/count/parser resources, structural checks, storage confirmation and same-selection retry. Students only list ready content. Skeletons support both themes, loading announcements and reduced motion; errors/empty states remain visible. See [PDF flow/rollout](course-notes.md) and frontend `docs/student-video-deterrents.md`.

**Evidence:** 48 backend tests pass using disposable MongoDB/HTTP and legacy FFmpeg regression with R2 mocked; eighteen frontend auth/video/proxy checks plus lint/build; isolated Chrome UI checks for video, course creation, notes/retry/assignment and loading states. Production dependency audits returned zero known vulnerabilities on this date. Existing older real-R2 local video evidence in `verification.md` does not verify today's hosted workflow. Actual admin bootstrap completion, credentials/rotation, backups and deployed settings remain unknown.

## P0 — before real learner invitations

### 1. Student email ownership — high, confirmed

`services/authService.js:19` accepts unverified public student registration; `controllers/assignmentController.js:23` assigns by the stored address. **Inferred impact:** a person registering another learner's email first can receive a later assignment. Admin-only instructor creation does not fix this student issue.

**Mitigation:** verified email or single-use recipient-bound invitations, with a public/invited admission decision. **Acceptance:** unverified addresses cannot gain course access; expired/replayed/concurrent redemptions fail; existing IDs/assignments survive migration.

### 2. Client attribution and abuse budgets — high, confirmed; hosted impact unknown

`app.js:51` resolves sessions before rate limiting and has no trusted-proxy setup. `middleware/requestLimits.js:7` separates authenticated budgets but anonymous/auth traffic uses socket IP and in-memory stores. Auth limiting covers `/auth/me` as well as credential routes and skips successes. Successful reset requests can repeatedly send/invalidate reset mail without consuming its failed-auth budget. Anonymous `/auth/me` failures can consume it. Frontend `worker/proxy.js:39` intentionally strips caller-supplied IP chains.

**Inferred impact:** shared edge/school addresses can share login limits; reset spam and pre-limiter work can consume resources. Restart/replicas reset/split budgets. **Mitigation:** verify actual Worker→Render and direct-Render paths, establish narrowly trusted identity, separate account/IP signup/login/reset budgets, limit before expensive work, and use shared storage before replicas. **Acceptance:** forged headers do not evade limits; a school sign-in burst works; account-targeted abuse is bounded without innocent lockout; restart/replica behavior is tested. Do not blindly enable `trust proxy=true`.

### 3. Intake and total storage quotas — high, confirmed

Video unfinished-count checking is separate from creation (`controllers/directVideoController.js:36`), so concurrent cross-lesson requests can exceed it. Signed PUT lacks enforced content length (`services/directVideoStore.js:19`); oversized bytes can reach R2 before finalization rejects them. No daily/total tenant budget exists. PDFs enforce 10 MiB intake and twenty atomic slots/course, but course creation is not globally capped.

**Mitigation:** atomic quota reservation, provider-supported enforced upload length and tenant/day byte/operation budgets. **Acceptance:** concurrent creates stay within reservations; actual-large/declared-small files are rejected before unbounded storage consumption; cancellation/retry/cleanup release capacity. The declared 2 GiB video limit is not a hard storage intake quota.

### 4. Backup/restore and provider/security settings — high, unknown

Code cannot prove Atlas backup/PITR, R2 private/public endpoint state, credential scope/rotation, network allowlists, lifecycle rules or operator bootstrap completion. Startup checks are point-in-time only (`server.js:13`).

**Mitigation:** document actual settings and rotation owner/date without exposing secrets, and rehearse DB-plus-referenced-media restore. **Acceptance:** isolated restore of users/roles, courses, notes, assignments/progress and media; agreed RPO/RTO (pilot proposal: ≤24h loss / ≤4h restore); verified private access, least-privilege permissions, HTTPS origins and production cookies. Secret rotation is unknown until evidenced.

### 5. Runtime readiness and hosted E2E — medium/high availability, confirmed/unknown

Cookie-less `/api/health` returns process liveness after DB/storage outages (`app.js:61`); DB disconnect logging does not change readiness (`config/db.js:19`). Ordinary frontend API timeout is 30 seconds. Hosting plan, cold starts/restarts and actual-domain authenticated/PDF/video behavior are untested here.

**Mitigation:** separate cheap liveness from bounded DB-aware readiness; observable storage degradation; an availability budget and operator-run E2E gate. **Acceptance:** dependency loss fails readiness promptly, reconnection recovers, and actual-domain admin/instructor/student/upload/notes/play/seek/renewal/reload/logout workflows pass, including cold start. Live checks remain with the user.

## P1 — small pilot, before expansion

### 6. Password recovery delivery — high, confirmed/unknown

`services/authService.js:36–68` writes a reset token before synchronous SMTP delivery, with no outbox/bounded retry. Sender ownership, delivery and hosting connectivity are unknown. Failure/timing differences for existing versus unknown accounts can be an **inferred enumeration signal**. Redemption/session revocation are implemented; delivery is not certified.

**Mitigation:** verified transactional delivery, bounded timeout/outbox/retry, uniform responses and separate abuse budgets. **Acceptance:** delivered/expired/replayed/concurrent reset tests; provider failure does not reveal account existence or create endless requests; no reset links/secrets in logs. Provider selection depends on actual hosting/network constraints.

### 7. Privileged account assurance — high residual risk, confirmed/unknown

No MFA, re-authentication for sensitive actions, session-review UI or rehearsed operator recovery is implemented. Ordinary sessions last seven days (`services/sessionService.js`). Public signup/reset minimum is eight characters versus twelve for private change and sixteen for bootstrap (`validators/authValidators.js`). Existing instructors are preserved for explicit review; bootstrap completion and temporary-password distribution are unknown.

**Mitigation:** prioritize privileged MFA/re-authentication, consistent password policy and recovery/access review. **Acceptance:** revocation remains effective, stolen/expired sessions are denied, public escalation stays impossible, recovery works without default credentials/public elevation. No accounts were automatically changed by this audit.

### 8. Cleanup and retention — medium, confirmed

Video incoming cleanup is best effort; legacy cleaner excludes direct assets (`controllers/directVideoController.js:65`, `services/videoWorker.js:79`). Abandoned incoming, failed copies and removed final videos can remain. PDF failures retain bounded retry/removal entries; interrupted uploads have leases but no scheduled reconciler. Archive deliberately retains PDFs/videos and their cost.

**Mitigation:** dry-run inventory/reconciliation with reference/age checks, separate incoming expiry and final-media retention. **Acceptance:** injected upload/copy/delete crashes are recoverable; orphan reports match references; no ready/archived referenced note/video is purged. Never apply incoming expiry to `notes/` or `videos/`.

### 9. Multi-record consistency/races — medium, confirmed patterns; outcomes inferred

Assignment then opening access is sequential (`controllers/assignmentController.js:26–29`); a guarded conflict can leave saved assignments, reported to the client. Revocation deletes enrollment then progress. Curriculum removal cancels assets then deletes records. Default module creation follows course creation. Readiness, ownership transfer and other edits are not serialized across every in-flight operation. Single-document archive guards prevent reopening and unfinished media stays filtered/denied.

**Mitigation:** define partial-result semantics; transactions/conditional revisions where required; interruption reconciliation. **Acceptance:** failure injection and transfer/archive/assignment/content races produce no unauthorized new ticket, silent ownership loss or unrecoverable state; retries show actual state. Preserve existing data during repair.

### 10. Monitoring/errors/audit durability — medium, confirmed; provider tooling unknown

HTTP logging is development-only (`app.js:56`); generic server errors have no structured operational record (`middleware/errorHandler.js`). Worker observability is disabled (`wrangler.jsonc`). Admin audit intent/outcome is useful but not immutable or a complete login/instructor event record; interruptions leave pending entries.

**Mitigation:** redacted request IDs/error/latency/dependency/storage/mail alerts, audit retention and pending-event review. **Acceptance:** faults can be traced and alert an owner; passwords/cookies/reset links/signed URLs/file bytes are absent; actual provider logging/retention/access is evidenced.

### 11. CI/staging and data-aware rollback — medium/high operations, confirmed/unknown

Backend lacks a checked-in CI workflow. Frontend build checks are documented, but branch protection and actual Git build settings are unknown. This release needs backend-first rollout. Older backend code below admin/archive enforcement can ignore suspension/archive (`docs/admin-rollout.md`). New note indexes are additive and initialized at startup.

**Mitigation:** disposable-DB CI/staging, revision/configuration records and rehearsed compatible rollback. **Acceptance:** failed checks block publication; old clients work with new backend; any rollback retains archive/status enforcement, notes and media. Push success does not prove hosted deployment success.

### 12. Performance/capacity — medium, confirmed design; capacity unknown

Course details polls course+progress every fifteen seconds and session state every minute (frontend `src/pages/courses/CourseDetailsPage.jsx`, `src/App.jsx`). One hundred simultaneously open student course pages imply roughly 900 API requests/minute before tickets/interactions, calculated from those intervals. Protected requests resolve/populate DB sessions. Course/assignment lists are unpaginated; admin lists paginate but search/count/population need query evidence. R2 carries video bytes directly.

**Mitigation:** visibility-aware/backoff polling, bounded lists, actual index/query checks and measured capacity. **Acceptance:** agree 25 concurrent viewers and a 100-user sign-in burst first; record p95 latency/error/start/seek/renewal/resource use. Test 100 simultaneous streams only if required. Enrollment is not concurrency proof.

### 13. Accessibility and learner resilience — medium, confirmed gaps; broader testing unknown

Skeleton themes/reduced motion and keyboard fullscreen are locally checked. Captions/transcripts, persisted playback position after reload, app error boundary and screen-reader audit remain absent. Refresh failure clears course/player data. PDF opening depends on popup/reader behavior. Notes are handouts; PDF-only courses have no lesson-completion percentage. Completion is self-reported.

**Mitigation:** caption/transcript process, focus/contrast/assistive audit, resilient transient errors, and explicit resume/completion policy. **Acceptance:** representative phones/readers/keyboard/assistive users can consume/retry content; errors never remain under skeletons; supported actual PDF open/download behavior works.

### 14. Sharing/capture limits — residual content risk, confirmed

Signed URLs are temporary bearer credentials; transfers/buffered/downloaded bytes can outlive expiry. CORS, `nodownload`, context-menu suppression and removable DOM overlays cannot stop network capture, OS recording or cameras. Native fullscreen/PiP/casting may omit the overlay. The partial learner ID omits full name/email but is correlatable, may collide and is not forensic proof. PDFs intentionally allow downloads.

**Mitigation:** truthful product/content policy, short/redacted links and deliberate watermark privacy/retention. **Acceptance:** revocation denies fresh links, failed renewal clears player, overlay avoids full PII, and browser claims match actual behavior. DRM/forensic marking requires separate future scope; none was purchased/promised.

### 15. Media/PDF assurance — medium, confirmed limits

Video validates browser first frame plus server metadata/header, not full codec/audio/duration. PDF structural/recognized-active-content checks are not antivirus or complete sanitization. Parser heap bounds do not cap all native/RSS allocations. No adaptive bitrate or resumable large-file transfer exists.

**Mitigation:** target-device media/document tests, maintained parsers/readers and bounded scanning if policy requires it. **Acceptance:** corrupt/resource-heavy fixtures fail within budgets; valid target files work; scanner failures stay private; memory measured with two concurrent PDF validations.

### 16. Privacy/export/deletion policy — medium, confirmed gap; policy unknown

No reviewed account export/deletion/retention process exists. Assignment revocation deletes progress; course archive preserves it. Audit/account/handout retention and learner-code disclosure need an owner. No jurisdictional compliance conclusion is made.

**Mitigation:** define export/deletion/recovery/retention semantics and support ownership. **Acceptance:** requests include related data without deleting others' records/media; archive/revocation semantics are documented; retained audit/media access is controlled.

## P2 — ongoing maintenance and scoped future features

### 17. Dependency/legacy surface maintenance — low currently, confirmed

Production audits reported zero known advisories on this date; that does not prove no vulnerabilities. Deprecated/unused dependencies and JWT/thumbnail/legacy-video compatibility surfaces remain (`package.json`, `middleware/errorHandler.js`, `videoRoutes.js`). Schedule patching and exposed-route review with regression tests. Acceptance: named update ownership, scheduled audits and compatibility tests for removals. Adaptive streaming, quizzes, certificates, payments and DRM need separate scope.

## Phased plan

1. **Before ten real learners:** decide admission/verification, mail/availability and retention; close identity/abuse/quota P0 gaps; evidence private credentials/settings/restore; operator-run actual-domain readiness/E2E; name incident owner and rollback reference.
2. **Ten-student invited pilot:** monitor login/reset/upload/notes/renewal and latency, validate phones/readers/accessibility, review existing privileged accounts/audit pending entries, rehearse interruption/restore/reconciliation. Finish P1 recovery/state-consistency work.
3. **Toward 25–100 enrolled:** improve polling/queries from measurements, stage/load-test agreed concurrency/sign-in bursts, verify usage budgets and shared limits before replicas, rehearse failure/rollback. Publish evidence with device/network assumptions.
4. **Ongoing:** dependency/credential/access reviews, restore tests, retention cleanup, incident drills and demand-driven features. Report findings do not themselves authorize implementation.

Today's feature checks reduce regression risk. Admission/abuse/quota gaps and recovery/readiness/deployment evidence remain the principal production follow-ups.
