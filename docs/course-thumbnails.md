# Private course thumbnails

Owners/admins upload or replace course covers with `POST /api/courses/:id/thumbnail` (one multipart `thumbnail` file). Ownership is checked before receiving bytes, and an atomic update rechecks ownership/archive state after storage. Students cannot upload. `GET /api/courses/:id/thumbnail` requires an authenticated owner/admin or an assigned student on an available, active course. Owners/admins can preview covers on archived courses.

Accepted inputs are still JPEG, PNG and WebP, at most **5 MiB and 16 megapixels**. Sharp decodes the actual bytes, rejects corrupt/unsupported inputs, strips metadata and normalizes to WebP bounded by 1200×675. The decoder has an eight-second processing timeout. At most two upload/processing jobs per API process are admitted; client disconnect does not free a running job's slot. These are resource bounds, not antivirus or a global storage quota.

Objects use unique `thumbnails/<course-id>/<version>.webp` keys in the existing private R2 bucket. PUT/HEAD verify size, type and hash metadata before changing the course. GET streams the bounded image through the authenticated API with `private, no-store`; raw object keys/bucket metadata are omitted from course responses. Already received pixels cannot be revoked.

Replacement/storage failure preserves the current cover. Successful replacements retain older objects for recovery. Archive preserves images. Existing Cloudinary URLs continue displaying until replaced; their inherited public visibility is unchanged. No migration, purge, Cloudinary setup or new provider is required. Orphan/replaced-object cleanup remains a separately reviewed retention task.

## Rollout

Deploy the backend before the frontend where deployment ordering is controlled. Install the committed lockfile with Node 22.12+ and the platform's optional Sharp native packages; do not omit optional dependencies. Existing `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` must allow **PutObject/GetObject/HeadObject on `thumbnails/`**, in addition to existing video/note prefixes. No new environment variables are required. Keep the bucket private and do not expire referenced thumbnail objects. Images use the existing same-origin `/api` proxy; no new browser-to-R2 CORS rule is required.

On 2026-10-02, **56 backend checks passed** with disposable MongoDB/HTTP, mocked R2 and existing legacy video regression fixtures. New checks cover real image decoding, size/pixel/type errors, store confirmation, authorization, reconnect persistence, safe replacement, archive/revocation, concurrent transfer and processing slots after disconnect. Production dependency audit: zero known advisories. Deployed credentials, storage and browser behavior still require operator verification; no live check was performed for this release.
