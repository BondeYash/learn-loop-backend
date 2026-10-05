# Practical tasks, private questions and saved learning place

The course owner or an administrator can author practical instructions, an optional checklist and an optional existing lesson link. Entitled students save a private text/checklist response and explicitly record self-reported completion. This is ungraded, does not certify competence and does not award lesson completion or assessment points. Editing a task increments its version; previous records remain retained and updated instructions require a new record. Hidden tasks and tasks linked to deleted lessons are unavailable to students.

Students can ask private course questions. Only that student and the course owner/admin can read the thread; owner lists include the student's name, not their email or account identifier. Replies are explicitly written by the owner/admin. Status is pending, answered or student-resolved; the student can reopen a thread. No bot answer, response-time promise, external message, attachment or public discussion is generated.

Every learner endpoint calls the existing full-course access check. Publication/archive, valid instructor assignment or explicit public enrollment, and current-mode verified paid status remain required. Public metadata discovery grants none of these rights. Owner actions enforce course ownership/admin authorization, including drafts. No production task, reply or question is seeded.

## HTTP endpoints and bounds

- `GET/POST /api/courses/:courseId/practicals`; owner/admin `PUT /api/courses/:courseId/practicals/:id`. Forty indexed task slots per course; checklist at most twenty items, 200 characters each; title 160 and instructions 5,000 characters.
- Student `POST /api/practicals/:id/record`: current task version, optimistic record revision and stable request UUID. One record per task/student/version; response at most 3,000 characters. Completing requires checking all authored checklist items. Retried accepted requests do not duplicate a record.
- Owner/admin `GET /api/courses/:courseId/practical-records`: private response history, twenty records per page.
- `GET /api/courses/:courseId/questions`; student `POST` with stable request UUID. Fifty retained threads per student/course, 2,000-character question and optional same-course lesson.
- Owner/admin `POST /api/course-questions/:id/replies`: thread version, stable UUID and at most 2,000 characters; ten replies per thread.
- Student `PUT /api/course-questions/:id/status`: expected thread version and resolved flag. Another student's ID cannot be used to read or update the thread.

Question requests are limited to ten per student/hour; other support writes to 120 per account/hour. These in-memory budgets apply per server instance and include retries. Lists are paginated at twenty entries with bounded page numbers. Unique indexes bound concurrent task/thread allocation; record and thread revisions prevent stale-tab overwrites. New support indexes are initialized before server startup. Course purge removes support records along with progress and existing course assets.

## Honest progress and resume

`POST /api/lessons/:id/visit` stores the authorized student's last available lesson, integer video position, timestamp and optimistic resume revision, with a stable UUID. Text positions must be zero. Video position is capped at four hours and the known video duration. Stale writes fail with 409; visit writes never award completion. Deleted or unavailable video targets are omitted from returned resume metadata without erasing completion history.

Progress reads derive completed/current lesson counts and percentage from the current curriculum. Signed-in course cards receive progress only when learning access is open, and Continue points to the latest valid saved lesson. Lesson completion still requires the explicit existing action. Quizzes, practical self-reports and passive video playback do not complete lessons.

The browser coalesces position writes, saves during periodic playback and on pause/seek, and restores the saved video position after metadata loads. Initial visits can refresh an outdated revision once. Subsequent stale writes stop until the student explicitly retries saving; ordinary fifteen-second course polling does not silently renew the lease. These are resume aids, not analytics or verified watch-time measurements.

## Verification and rollout

`tests/learningSupport.test.js` uses disposable local MongoDB and HTTP for role/ownership/student isolation, private DTOs and public-metadata redaction, idempotent records/questions/replies, stale revisions, truthful completion, bounded positions, deletion/revocation/session/payment denial, allocation/rate limits and purge. All 123 integrated backend tests passed, including existing assessment, catalog, account, storage and mocked payment regressions. No real charges, provider changes, production enrollment or external messaging is performed.

Deploy the backend before or with its matching frontend through the existing pipelines. No new provider, secret, hosting setting or bulk course visibility/access migration is needed. Public health/catalog reads can establish deployment availability; authenticated support workflows still need ordinary owner/student acceptance testing on real authored content.
