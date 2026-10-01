# Local direct-R2 verification

Verified on 2026-10-01 with synthetic accounts/content, local Vite/Node services, MongoDB Atlas and private Cloudflare R2. No production deployment or load test was performed.

- Instructor browser: retried the existing MP4 session after the bucket CORS rule was saved; direct PUT, metadata/container verification and conditional R2 copy reached Ready to play. The same lesson/session was reused.
- Storage: 1,314,164-byte video/mp4 matched the declared size and upload-session metadata. The temporary object was removed; no local asset directory existed. The API started with unavailable FFmpeg paths while its legacy worker was disabled.
- CORS: GET/HEAD/PUT preflights returned 204 for the exact localhost:5173 and 127.0.0.1:5173 origins. An unlisted origin returned 403 without an allow-origin header.
- Instructor browser: published the synthetic course and assigned the test student.
- Assigned student browser: saw the course, played all eight seconds with no media error, sought to four seconds, marked completion and reloaded. Session and 100% completion persisted.
- A temporary 60-second playback lifetime verified automatic signed URL renewal while preserving the paused four-second position. The API was then restored to the normal 300-second lifetime.
- Unassigned student browser: dashboard showed zero assigned courses; opening the direct course route displayed access denied with no video element.
- Real HTTP/R2 revocation check: removing only the synthetic assignment denied a new ticket (403). The already issued unexpired URL still served a byte range (206), as documented. Assignment was restored and fresh access returned 200.
- Frontend: lint, eight tests and production build passed. Backend: 25 tests passed, including legacy regression tests and new real-MongoDB/HTTP tests with explicitly mocked object storage. Production dependency audits found zero known vulnerabilities; staged files were scanned for credentials before publication.

The short fixture does not verify large-file performance, every interruption/cancellation point, every codec/browser/device, deployed cookie/proxy settings, backup recovery or viewer capacity. H.264/AAC MP4 remains the recommended input. Signed URLs remain bearer credentials until expiry; buffered/downloaded bytes cannot be revoked.
