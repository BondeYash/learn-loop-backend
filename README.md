# LessonLoop backend

Frontend: [BondeYash/learn-loop-frontend](https://github.com/BondeYash/learn-loop-frontend).

LessonLoop is a video-learning application for instructors and assigned students. This is the independent API repository split from the original LMS-platform project.

Instructors create courses, modules and lessons, upload precompressed MP4 videos, publish, and assign registered students by email. Students see their assigned published courses, play private videos and track completion. The interface uses system typography, neutral light/dark surfaces and one blue accent.

## Stack

React 18, Vite 7, React Router 7, Redux Toolkit, Axios and Tailwind CSS; Node.js 22.12+, Express and MongoDB/Mongoose. Private Cloudflare R2 stores videos. New uploads and playback transfer directly between the browser and R2. The API handles accounts, course metadata, assignments and short-lived storage links. New uploads need neither FFmpeg nor local staging disk.

## Local setup

Run `npm ci` in this repository root. Copy `.env.example` to `.env` only when `.env` does not exist. Enter credentials directly in `.env`; never put secrets in frontend variables or source control. Start the separate frontend repository on port 5173. No parent server/client directory is needed.

Required backend values are `MONGO_URI`, `MONGO_DB_NAME=lms`, `CLIENT_URL=http://localhost:5173`, `VIDEO_STORAGE_PROVIDER=r2` and the four `R2_*` settings. The API defaults to port 5000. MongoDB can be local or Atlas; `MONGO_DB_NAME` explicitly selects the database even if the URI omits it.

Keep the bucket private and its public endpoints disabled. Use an object read/write credential limited to that bucket. The API uses the standard account S3 endpoint with region `auto`. The existing key needs object access; it does not need bucket configuration permissions. A dashboard administrator applies bucket CORS separately.

In Cloudflare R2, select the bucket, then **Settings → CORS Policy**. Add the rule in [docs/r2-local-cors.json](docs/r2-local-cors.json), preserving other rules. It permits only `http://localhost:5173` and `http://127.0.0.1:5173`, with GET/HEAD/PUT and the headers the app uses. A deployed frontend needs its actual exact origin added separately. Do not use `*` or make the bucket public.

Start this API with `npm start`, and run `npm run dev -- --host 127.0.0.1 --strictPort` in the separate frontend repository. Open http://localhost:5173. Vite proxies `/api` to the API; keep `VITE_API_URL=/api`.

Startup checks MongoDB and R2, and creates the General category if missing. `/api/health` reports HTTP service health; it is not a continuous database/storage diagnostic.

## Course flow

1. Register as an instructor or student. Public signup cannot create administrators.
2. Create a course draft, add a module and a video lesson.
3. Select a precompressed H.264/AAC MP4, up to 2 GiB and four hours. Convert WebM/MOV externally first. Wait for **Ready to play** and preview it.
4. Publish when all video lessons are ready. Assign registered student email addresses in **Assigned students**.
5. Assigned students sign in, open the course, play/seek lessons and mark completion. Completion reflects the current curriculum when lessons change.

## Direct uploads

The browser checks the MP4 header and decodes the first frame before requesting an upload session. This catches renamed files and files that this browser cannot begin playing. It does not prove every frame or audio codec works on all devices. H.264 video with AAC audio and fast-start MP4 metadata is recommended; the app performs no conversion, optimization or adaptive streaming.

The API checks lesson ownership, bounds on claimed duration/dimensions/size, and assigns an unpredictable temporary object key. A short-lived signed PUT URL fixes that key and required Content-Type/upload-session headers. The browser sends file bytes directly to R2 without the API cookie. Default upload URL lifetime is 15 minutes, configurable from 60 seconds to one hour. At most three unfinished upload sessions per instructor are accepted.

After upload, the API verifies the expected key, exact byte length, Content-Type, session metadata and MP4 container header. It reads 64 bytes, not the full video. It conditionally copies the verified object inside R2 to a unique final key using the source ETag, then confirms the result. Published objects never receive a signed PUT URL, so reusing an outstanding upload URL cannot overwrite a ready video. Client duration/dimensions and session metadata are not independent codec validation or a content-security scan.

Progress, cancellation and errors are visible. Interrupted single-PUT transfers restart from the beginning when the same file is selected; there is no resumable multipart transfer. An expired upload URL gets one automatic renewal attempt. Upload sessions expire after 24 hours. **Check uploaded file** retries confirmation after a completed transfer or dropped response; confirmation is idempotent and a stale verification claim can be retried after two minutes. Remove an expired session before selecting a fresh file.

Successful confirmation attempts to delete only its temporary `incoming/` object. An unexpired PUT URL can recreate that temporary object, so configure a lifecycle rule scoped to `incoming/` to expire abandoned objects after a suitable short retention period (for example two days). Do not apply that expiry to `videos/`. Removed final videos remain retained in this version; retention/garbage collection needs a separate reviewed policy. This flow is not a hard storage quota against a malicious uploader.

## Private playback and sessions

`GET /api/lessons/:lessonId/playback` checks the live session, ownership or assignment, publication and readiness, then issues a signed R2 GET URL. The default lifetime is five minutes, configurable from 60 seconds to 15 minutes. The native player uses R2 byte ranges for seeking, renews before expiry and restores the playback position. Renewal failure shows a retryable error. The course screen also refreshes access approximately every 15 seconds.

Revoking assignment, unpublishing or logging out blocks new playback tickets. An already issued URL is a bearer credential usable until expiry, and downloaded/buffered bytes cannot be revoked. Do not log/share signed URLs. This is private access control, not DRM. URLs are held in component memory, not browser storage.

Opaque seven-day sessions use HttpOnly, SameSite=Lax cookies scoped to `/api`, with Secure enabled in production. MongoDB stores only token hashes. Logout revokes the current session; password reset revokes all account sessions. The client handles restoration, expiry, cross-tab account changes and stale responses. SMTP is required for password-reset delivery. Email verification, instructor invitations/approval and MFA are not implemented.

## Existing videos

Existing ready R2 video records and keys remain usable by the signed player. The old authenticated proxy endpoint and chunk-processing code remain for compatibility, but the worker is disabled by default. `ENABLE_LEGACY_VIDEO_WORKER=true` explicitly enables the old FFmpeg worker and requires persistent staging plus FFmpeg/FFprobe. It never processes or cleans new direct-upload assets. Local-only legacy videos need a separate R2 migration before the new player can use them; no migration or deletion is automatic.

## Verification

In this repository: `npm test`, `npm audit`. The complete suite requires a disposable local MongoDB on port 27018 and FFmpeg/FFprobe for legacy regression tests. It creates a random `lms_test_*` database and temporary files, then removes only those fixtures. It does not load `.env` or use Atlas/R2 credentials. `node --test tests/direct.test.js` checks only the new flow, using real local MongoDB/HTTP with mocked object storage, without FFmpeg. `TEST_MONGO_PORT` overrides the local test port.

The automated suite has 25 passing tests. The new storage tests distinguish SDK mocks from the real MongoDB/HTTP flow. Existing ready R2 samples load and renew signed URLs in the local browser. Browser direct upload still awaits bucket CORS, so the complete new browser upload-to-student flow remains unverified. See [deployment guidance](docs/deployment.md) for the same-origin Vercel/Render setup. No production deployment or concurrent-viewer load test has been performed. Captions, adaptive bitrate, quizzes, payments and certificates remain outside scope.
