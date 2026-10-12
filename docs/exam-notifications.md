# Parse exam notifications

## Render setup

In Parse, open **Settings → API Keys**, create a key and copy it privately. In the Render **backend** service's Environment settings, add `PARSE_API_KEY` and save/redeploy. No frontend key or `VITE_*` variable is needed. Do not paste keys in chat, logs or Git.

The application uses the existing [SarkariResult.com.cm marketplace API](https://parse.bot/marketplace/3f255041-7d25-4c19-baee-d78c7e8592bf/sarkariresult-com-cm-api). It does not create, revise or purchase a scraper. The publicly verified canonical scraper ID is `c0f29a36-31f9-4da4-aeb3-63d34d3ca574`. If using a subscribed copy, optionally set `PARSE_SCRAPER_ID` to that copy's UUID. The copy must expose the same GET `list_posts` contract. Authentication follows [Parse's API-key documentation](https://docs.parse.bot/authentication).

Once deployed, visiting the homepage or `GET /api/public/exam-notifications` starts the first fetch if the key is present. The route is anonymous and returns the normal `{success, message, data}` envelope. `data` contains `enabled`, `status` (`disabled`, `ready`, `stale`, `unavailable`), `notices`, `updatedAt` and source attribution. Without a key, the section stays hidden. A configured but failing source produces a friendly unavailable state without breaking courses.

## Coverage and credit usage

The only provider call is:

```text
GET https://api.parse.bot/scraper/{scraper_id}/list_posts?page=1&category=latest-job
X-API-Key: [private environment value]
```

This fetches the latest page of exam/recruitment notices. It is not an exhaustive exam calendar, historical archive, admit-card/result feed or official government feed. At verification, Parse lists this endpoint at one credit per successful call; verify current pricing and credit renewal in your account.

MongoDB stores one shared cache document and reserves the next attempt before calling Parse. There is at most one attempt every 12 hours, roughly 62 attempts over 31 days, independent of visitors, caller parameters, server instances and restarts. Refresh is demand-driven: the first visit after expiry starts it, so an idle/sleeping Render service spends no credits. Public search and “show all” use the already fetched list. No pagination, detail lookup, forced refresh, automatic retry loop, background scheduler or paid scraper creation is exposed.

Refresh failures retain the last successful feed and its original timestamp. Data older than seven days is hidden. Provider `Retry-After` can extend the 12-hour interval. A failed or crashed attempt still reserves the interval; changing a key or redeploying does not reset the budget. After fixing credentials, allow the next refresh window. Do not delete the cache collection to bypass this limit.

Only normalized titles, allowlisted HTTPS publisher URLs and publication dates are exposed. Provider HTML, eligibility, application deadlines, vacancy counts and raw error bodies are omitted. Dates in notifications must be confirmed with the recruiting authority. The frontend labels the publisher and Parse explicitly and links to the source in a separate tab.

## Diagnostics and verification

Check `data.enabled` and `data.status` on the public route. Render logs report only a short code: `configuration` (key/scraper access), `credits`, `rate_limit`, `invalid_response`, `unavailable` or `cache_unavailable`. Keys, full provider responses and account details are never logged by this integration. A 15-second provider timeout and 512 KiB body limit bound each call; redirects are rejected.

`node --test tests/examNotifications.test.js` uses isolated MongoDB on `TEST_MONGO_PORT` (default 27018) and mocked provider responses. It covers safe normalization, bad URLs, response limits, anonymous HTTP access, disabled setup, concurrency, durable budgeting across restart, stale delivery, failures, expiry and Retry-After. No Parse key or credits are used in tests.
