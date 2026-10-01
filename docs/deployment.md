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

Render free services may sleep, take time to wake and use ephemeral filesystems. A cold start can exceed the frontend's 30-second API timeout, requiring retry. Provider quotas and eligibility can change; review the current [Render free-service limits](https://render.com/docs/free) and provider pricing before deployment. Free-start-friendly does not mean unlimited video storage/operations, availability or viewers.

Use one API process initially. Rate limits currently use in-memory stores; replicas require shared limits and explicit trusted-proxy configuration based on the actual topology. Do not blindly trust arbitrary X-Forwarded-For values. Back up MongoDB, monitor errors and R2 usage, and establish reviewed retention rules. Temporary `incoming/` objects can expire separately; final `videos/` objects must not inherit that expiry. Signed URLs remain usable until expiry even after revocation.

Before launch, verify HTTPS login/logout/reload, secure cookie attributes, SPA deep links, API no-store responses, CORS preflight, instructor MP4 upload/confirmation/publication, assigned student play/seek/reload, URL renewal and unassigned/revoked denial using the actual deployed domains. Check first-frame and audio compatibility on target mobile/desktop browsers. No deployed-domain checks or load tests are claimed by the local verification record.
