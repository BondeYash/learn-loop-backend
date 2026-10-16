# Backend reliability review — 16 October 2026

The matching frontend contains the [combined audit, measurements, reproduction steps and remaining production checks](https://github.com/BondeYash/learn-loop-frontend/blob/main/docs/platform-audit-2026-10-16.md).

This release fixes shared-proxy failed-login accounting, malformed password handling, completion of unfinished lessons, simultaneous lesson-completion races, duplicate curriculum work, course-picker overfetching, concurrent upload allocation and password-reset delivery cleanup. It adds indexes for course assignments, published/instructor course queries and unfinished uploads.

`GET /api/health` is liveness and remains independent of session/database lookups. `GET /api/ready` returns 200 when Mongoose reports a connected database and 503 otherwise; it does not ping the database or check payment, AI, mail or storage services. Both include `data.databaseReady` and a short `data.commit` when Render supplies a valid `RENDER_GIT_COMMIT`.

`GET /api/courses?enrolled=true` restricts the student result to accessible enrolled courses, retaining payment verification and individual payment waivers. An accessible student's course detail now includes `data.progress`; `/progress` remains supported for existing clients. Progress counts currently available text lessons and ready videos.

`UploadCreationLock` uses its owner key and an expiring token to serialize allocation only, across direct and optional legacy endpoints. Its expiry index is initialized at startup. File transfers retain concurrency. The legacy conversion path remains disabled in production unless explicitly configured.

The release suite passed **177 tests** using disposable MongoDB databases, real HTTP and synthetic external providers. A warm local experiment with 50 lessons and 3,001 enrollments completed 40 authenticated course opens at concurrency 10 with zero errors (p50 217.3ms; p95 283.3ms). The assignment query examined one document using the new compound index. These measurements do not establish production capacity, actual live provider delivery or recovery from a real hosting outage.

Production dependency audit: zero known vulnerabilities at review time. No production data changes, real payments, outbound mail or paid AI calls were made by these tests. Confirm index creation, backups/restore, hosting capacity, trusted proxy identity and real provider behaviour in the deployment as described in the combined report.
