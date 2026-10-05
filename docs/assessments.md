# Authored quizzes and mock tests

Owners and administrators can author chapter quizzes and timed course mock tests for any course. A chapter is an existing course module; no official questions, exam promises or CCC-specific question bank is supplied. Drafts can have no questions. Publishing requires complete question text, 2–6 distinct options, one correct answer and an explanation. Topic tags are optional author-defined text. Quiz timers are optional; mock timers are required.

## API and access

All routes require the existing session and role checks. Authoring uses `requireCourseOwner`; learner list/start/answer/submit/result/history use `requireCourseAccess`, retaining publication/archive, private assignment, explicit public enrollment and current-mode paid entitlement. There is no anonymous assessment or public-sample exception.

- Owner/admin: `GET /api/courses/:courseId/assessments/manage`, `POST /api/courses/:courseId/assessments`, `PUT /api/courses/:courseId/assessments/:id`.
- Learner: `GET /api/courses/:courseId/assessments`, `POST /api/assessments/:id/attempts`.
- Own attempt: `GET /api/assessment-attempts/:id`, `PUT /api/assessment-attempts/:id/answers`, `POST /api/assessment-attempts/:id/submit`.
- Own history: `GET /api/courses/:courseId/assessment-attempts?page=1`, 20 entries per page.

Authoring bodies include `title`, `kind` (`quiz`/`mock`), `module` for a quiz, `durationMinutes` (integer or null for untimed quiz), `status` (`draft`/`published`) and `questions`. Each question contains `prompt`, `options`, `correctIndex`, `explanation` and optional `topic`. Updates must include the last received `version`; conflicting edits return 409. Answer bodies contain `questionIndex` and `optionIndex` (or null to clear). Start/submit ignore client-supplied answers, scoring, timestamps and ownership.

## Integrity and limits

Every attempt captures an immutable question/version snapshot. Drafting or editing stops new attempts as appropriate, while existing attempts retain their original questions and may continue while course entitlement remains valid. Removing a chapter prevents new quizzes on that chapter; existing attempt snapshots are retained. Student active/list/history responses omit keys and explanations. Only the student's own ended attempt exposes its explanation review. Snapshots and authored questions are excluded from default model projections, with explicit response serializers at the protected endpoints.

A unique database index permits one active attempt per student/assessment, so concurrent/retried starts resume it. Deadlines are server timestamps; MongoDB server time prevents late answer writes. Refresh does not restart the timer. Expired attempts finalize when an attempt/history/start/answer/submit endpoint next observes them; there is no background timer service. Submission is idempotent, and revision-based compare-and-swap scoring includes accepted answers racing with submission. Clients cannot overwrite an ended result.

Limits are 40 assessments per course, 40 questions each, 2–6 options, 1–180 timed minutes and 100 attempts per learner/assessment. Unique numbered slots enforce the assessment/attempt caps during concurrent creation. Drafts count toward the course limit; assessment deletion/reclamation is outside this slice. Text limits are 160 title, 1200 prompt, 400 option, 2000 explanation and 80 topic characters. Each correct answer earns 1; incorrect/unanswered earns 0. No negative marking or pass/readiness threshold is configured.

Own history aggregates explicit tags from the latest 100 ended attempts. Tags below 70% correct form the weak-topic summary; untagged questions are excluded. This summarizes practice on authored question versions and does not establish official exam readiness. Lesson completion stays in existing `Progress`; quiz submission does not mark a lesson or course complete. Archive preserves assessments and attempts; existing permanent course purge removes them.

## Verification and rollout

`tests/assessments.test.js` uses isolated MongoDB/HTTP and synthetic questions for ownership, empty drafts/publication validation, key leakage, private/public/paid entitlement, expired sessions, timer/late answers, refresh persistence, immutable snapshots, concurrent starts/submission/answer races, bounded creation and purge. Run with `node --test tests/assessments.test.js`; the complete backend suite also includes prior public enrollment, payments and media regressions.

No seed, data migration, payment-provider change or external service is introduced. Startup awaits initialization of the new assessment/attempt collections and unique indexes before serving requests, following the existing payment-model startup pattern. The frontend and backend increments must both be deployed for these pages to work. Local tests and GitHub publication do not verify a hosted authentication session or deployed assessment APIs.

Practical exercises, saved learning place/current progress and private questions are now delivered in [learning support](learning-support.md). Instructor attempt analytics, negative marking and assessment deletion remain outside these stages.

On 2026-10-05, the full isolated backend suite passed all 114 tests. A final focused assessment rerun passed all 9 tests after startup was changed to await assessment/attempt model initialization. Frontend lint/unit/build/dry-run and isolated assessment/public/payment/player browser flows also passed. These checks did not create production course or assessment data.
