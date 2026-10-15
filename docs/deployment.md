# Current frontend hosting

For the course PDF assistant, follow [Doubt Dost setup and usage controls](doubt-dost.md). Its key belongs only in the Render backend.

The frontend now uses Cloudflare Workers Static Assets with a same-origin API proxy, not the earlier Vercel proposal below. Follow the [current frontend deployment instructions](https://github.com/BondeYash/learn-loop-frontend/blob/main/docs/deployment.md). Backend Render/Atlas/private-R2 requirements below remain relevant. For this release, follow [admin setup and safe rollout](admin-rollout.md), including rollback restrictions after archive/suspension.

## Earlier deployment proposal (historical)

# Deployment guidance

The intended initial topology is a static Vite frontend on Vercel, a small Node API on Render, MongoDB Atlas, and private R2. New video bytes travel directly between browser and R2; API requests carry metadata and temporary storage links. This removes mandatory video conversion, local upload disk and API video bandwidth for the new flow. It does not guarantee zero cost or a particular concurrency level.

## Backend

Create a Node service from the backend repository with `npm ci` as build command and `npm start` as start command. Use Node 22.12+ and the host-provided PORT. Configure `NODE_ENV=production`, `MONGO_URI`, `MONGO_DB_NAME=lms`, the exact HTTPS frontend origin as `CLIENT_URL`, `VIDEO_STORAGE_PROVIDER=r2`, the private R2 settings, and `ENABLE_LEGACY_VIDEO_WORKER=false`. No persistent disk or FFmpeg is required for direct uploads. Retain old local media separately if migrating an existing installation.

Use `/api/health` as the HTTP health endpoint. Keep secrets on the backend. Configure Atlas network access for the actual deployment and preserve existing data; do not open access blindly. No billing, account permissions or production resources are changed by this repository.

## Frontend and cookies

Build with `npm run build`; output is `dist`. Keep `VITE_API_URL=/api`. Add a `vercel.json` to the frontend root only once the real backend hostname is known. The following is a template, not a configured deployment:

```json
{
  "rewrites": [
    { "source": "/api/:path*", "destination": "https://REPLACE_WITH_REAL_BACKEND_HOST/api/:path*" },
    { "source": "/((?!api/).*)", "destination": "/index.html" }
  ],
  "headers": [
    { "source": "/api/:path*", "headers": [
      { "key": "Cache-Control", "value": "private, no-store" },
      { "key": "x-vercel-enable-rewrite-caching", "value": "0" }
    ] }
  ]
}
```

The external rewrite keeps browser `/api` requests on the frontend origin. Preserve Cookie/Set-Cookie, Origin and normal fetch metadata headers. Cookies are host-only (no Domain), HttpOnly, Secure in production, SameSite=Lax and Path=/api. The API denies cross-site writes and unexpected origins. Pointing VITE_API_URL directly at an unrelated Render hostname is not the supported cookie setup; CORS alone cannot fix cross-site cookie restrictions.

Set `CLIENT_URL` to the actual frontend origin. Add that exact origin to the bucket CORS rule (no trailing path, wildcard or invented preview domains), preserving existing rules. Keep the R2 bucket private. Use [r2-local-cors.json](r2-local-cors.json) only for local development. See [Cloudflare CORS documentation](https://developers.cloudflare.com/r2/buckets/cors/) and [Vercel rewrite documentation](https://vercel.com/docs/rewrites).

## Operational limits and launch checks

Render free services may sleep, take time to wake and use ephemeral filesystems. A cold start can delay an uncached response. The public landing page allows 60 seconds per request and retries transient failures automatically; other API calls retain the default 30-second timeout. Provider quotas and eligibility can change; review the current [Render free-service limits](https://render.com/docs/free) and provider pricing before deployment. Free-start-friendly does not mean unlimited video storage/operations, availability or viewers.

Use one API process initially. Rate limits currently use in-memory stores; replicas require shared limits and explicit trusted-proxy configuration based on the actual topology. Do not blindly trust arbitrary X-Forwarded-For values. Back up MongoDB, monitor errors and R2 usage, and establish reviewed retention rules. Temporary `incoming/` objects can expire separately; final `videos/` objects must not inherit that expiry. Signed URLs remain usable until expiry even after revocation.

Before launch, verify HTTPS login/logout/reload, secure cookie attributes, SPA deep links, API no-store responses, CORS preflight, instructor MP4 upload/confirmation/publication, assigned student play/seek/reload, URL renewal and unassigned/revoked denial using the actual deployed domains. Check first-frame and audio compatibility on target mobile/desktop browsers. No deployed-domain checks or load tests are claimed by the local verification record.

## Public landing page cache

`worker/publicCache.js` caches only GET `/api/public/courses` with the default empty search/category, page 1 and limit 12, and GET `/api/public/exam-notifications` with no query. These reads strip Cookie and Authorization before reaching Render. Responses with cookies, invalid DTOs or non-200 statuses are never saved. Other methods, query variants and protected endpoints retain the existing proxy behavior and credentials.

The unfiltered listing is fresh for 60 seconds and can be served while refreshing for up to 10 minutes. Notices are fresh for five minutes and retained for six hours, subject to their seven-day source age limit. Background refresh has a 25-second timeout, concurrent requests share a refresh within the Worker instance, and unsuccessful refreshes have a 15-second cooldown. Browser responses continue to use no-store headers; `X-Public-Cache` reports HIT, STALE or MISS for these two endpoints. Cache failures fall back to the normal API. No new binding or paid service is required.

The browser keeps only validated public metadata, revalidates on mount, and uses skeletons and automatic retries for cold starts. Course-list metadata can briefly lag a price or publication change; protected content, public course detail and checkout eligibility/prices are checked afresh. The sales page displays actual course prices and introduces no fabricated comparison price or purchase operation.

Validate with `npm test`, `npm run lint`, `npm run build`, `npm run check:cloudflare`, and `tests/landing_load_browser.py` / `tests/exam_notifications_browser.py` / `tests/public_catalog_browser.py`. Backend catalog tests verify readiness for text, PDFs, unfinished videos and empty courses. Cache behavior follows [Cloudflare Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) and [Worker background tasks](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil).
