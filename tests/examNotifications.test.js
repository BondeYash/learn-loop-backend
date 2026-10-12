import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import mongoose from "mongoose";
import app from "../app.js";
import ExamNotificationCache from "../models/ExamNotificationCache.js";
import { createExamNotificationService, fetchExamNotifications, normalizeExamNotifications, EXAM_FEED_ID, EXAM_REFRESH_MS } from "../services/examNotifications.js";

const env = { PARSE_API_KEY: "pmx_PRIVATE_TEST_KEY" };
const row = { id: 1, title: "SSC &amp; Railway &ndash; Recruitment", link: "https://sarkariresult.com.cm/fixture-notice/", date: "2026-10-12T13:00:00", last_date: "UNVERIFIED DEADLINE", total_posts: "UNVERIFIED VACANCIES" };
const body = { status: "success", data: { posts: [row], page: 1, total_pages: 12 } };
const response = () => Response.json(body);

test("notices expose plain titles, source-only HTTPS links and valid publication dates", () => {
  const notices = normalizeExamNotifications({ ...body, data: { posts: [
    row, { ...row, link: row.link + "?tracking=1#fragment" },
    { ...row, title: "&lt;b&gt;Hindi हिन्दी &#x1f4da;&lt;/b&gt;", link: "https://www.sarkariresult.com.cm/hindi/", date: "2026-02-30T00:00:00" },
    ...["javascript:alert(1)", "http://sarkariresult.com.cm/a", "https://evil.invalid/", "https://sarkariresult.com.cm.evil.invalid/a", "https://secret@sarkariresult.com.cm/a", "https://127.0.0.1/a", "https://sarkariresult.com.cm:8443/a"].map(link => ({ ...row, link })),
  ] } });
  assert.equal(notices.length, 2);
  assert.equal(notices[0].title, "SSC & Railway – Recruitment");
  assert.equal(notices[1].title, "Hindi हिन्दी 📚");
  assert.equal(notices[1].publishedOn, null);
  assert.equal(notices[1].url, "https://sarkariresult.com.cm/hindi/");
  assert.deepEqual(Object.keys(notices[0]).sort(), ["id", "publishedOn", "title", "url"]);
  assert.equal(JSON.stringify(notices).includes("UNVERIFIED"), false);
  for (const payload of [null, [], {}, { data: { posts: {} } }, { status: "error", data: body.data }, { error: "sensitive", posts: [row] }, { posts: [{ title: "Broken" }] }]) assert.throws(() => normalizeExamNotifications(payload));
  assert.deepEqual(normalizeExamNotifications({ posts: [] }), []);
});

test("Parse calls the fixed marketplace GET endpoint once and bounds/errors safely", async () => {
  let calls = 0;
  const notices = await fetchExamNotifications({ env, fetchProvider: async (url, init) => {
    calls++;
    assert.equal(url, "https://api.parse.bot/scraper/c0f29a36-31f9-4da4-aeb3-63d34d3ca574/list_posts?page=1&category=latest-job");
    assert.equal(init.headers["X-API-Key"], env.PARSE_API_KEY);
    assert.equal(init.method, "GET"); assert.equal(init.redirect, "error"); assert.ok(init.signal instanceof AbortSignal);
    return response();
  } });
  assert.equal(calls, 1); assert.equal(notices.length, 1);
  for (const status of [401, 402, 403, 429, 500, 502, 503]) {
    await assert.rejects(fetchExamNotifications({ env, fetchProvider: async () => new Response("SENSITIVE_PROVIDER_RESPONSE", { status }) }), error => !error.message.includes("SENSITIVE"));
  }
  await assert.rejects(fetchExamNotifications({ env, fetchProvider: async () => new Response(" ".repeat(512 * 1024 + 1)) }), { code: "invalid_response" });
  await assert.rejects(fetchExamNotifications({ env: { ...env, PARSE_SCRAPER_ID: "https://evil.invalid" }, fetchProvider: async () => assert.fail("Must not fetch") }), { code: "configuration" });
  await assert.rejects(fetchExamNotifications({ env, now: () => 1000, fetchProvider: async () => new Response("", { status: 429, headers: { "Retry-After": "86400" } }) }), error => error.code === "rate_limit" && error.retryAt === 86401000);
});

test("notification HTTP cache shares a durable free-plan budget across concurrency and restarts", { timeout: 60000 }, async (t) => {
  await mongoose.connect(`mongodb://127.0.0.1:${process.env.TEST_MONGO_PORT || 27018}/lms_test_${crypto.randomBytes(6).toString("hex")}`, { serverSelectionTimeoutMS: 5000 });
  await ExamNotificationCache.init();
  let time = Date.parse("2026-10-12T10:00:00Z"), calls = 0, provider = response;
  const logs = [];
  const make = (settings = env) => createExamNotificationService({ env: settings, now: () => time, fetchProvider: async () => { calls++; return provider(); }, log: code => logs.push(code) });
  let service = make();
  app.locals.examNotificationService = service;
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api/public/exam-notifications`;
  const http = async (suffix = "", method = "GET") => { const r = await fetch(url + suffix, { method }); return { status: r.status, body: await r.json() }; };
  async function settled() {
    for (let n = 0; n < 100; n++) {
      const cache = await ExamNotificationCache.findById(EXAM_FEED_ID).lean();
      if (cache?.lastError || cache?.fetchedAt?.getTime() === time) return cache;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail("Background refresh did not settle");
  }
  try {
    await t.test("disabled feed neither touches Mongo nor spends credits", async () => {
      const disabled = createExamNotificationService({ env: {}, model: { findById: () => assert.fail("No database access needed") }, fetchProvider: () => assert.fail("No provider call") });
      assert.equal((await disabled.get()).enabled, false);
    });
    await t.test("concurrent first visitors and separate service instances call Parse only once", async () => {
      await Promise.all(Array.from({ length: 30 }, (_, index) => (index % 2 ? service : make()).get()));
      const result = await http();
      assert.equal(calls, 1); assert.equal(result.status, 200); assert.equal(result.body.data.notices.length, 1); assert.equal(result.body.data.status, "ready");
      assert.equal(JSON.stringify(result).includes(env.PARSE_API_KEY), false);
    });
    await t.test("restart and caller search/force/page parameters cannot bypass the budget", async () => {
      app.locals.examNotificationService = make();
      for (const query of ["?force=true", "?page=100&category=result", "?url=https://evil.invalid&search=SSC"]) assert.equal((await http(query)).status, 200);
      assert.equal(calls, 1);
      assert.equal((await http("", "POST")).status, 404);
    });
    await t.test("stale cache is returned immediately while one refresh is in flight", async () => {
      time += EXAM_REFRESH_MS + 1;
      let release;
      provider = () => new Promise(resolve => { release = () => resolve(response()); });
      service = make(); app.locals.examNotificationService = service;
      const result = await http();
      assert.equal(result.body.data.status, "stale"); assert.equal(result.body.data.notices.length, 1);
      for (let n = 0; !release && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.ok(release); release(); await settled();
      assert.equal((await http()).body.data.status, "ready"); assert.equal(calls, 2);
    });
    await t.test("provider failures preserve last good notices and never echo secrets", async () => {
      time += EXAM_REFRESH_MS + 1;
      provider = () => new Response("pmx_PRIVATE_TEST_KEY SENSITIVE_PROVIDER_RESPONSE", { status: 402 });
      await http(); await settled();
      const result = await http();
      assert.equal(result.body.data.notices.length, 1); assert.equal(result.body.data.status, "stale");
      assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
      assert.equal(logs.at(-1), "credits");
      await make().get(); assert.equal(calls, 3);
    });
    await t.test("seven-day-old data is hidden and malformed refresh does not overwrite it", async () => {
      time += 8 * 24 * 60 * 60 * 1000;
      provider = () => Response.json({ status: "success", data: { unexpected: [] } });
      const result = await http(); assert.equal(result.body.data.status, "unavailable"); assert.deepEqual(result.body.data.notices, []);
      for (let n = 0; logs.at(-1) !== "invalid_response" && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(logs.at(-1), "invalid_response");
      assert.equal((await ExamNotificationCache.findById(EXAM_FEED_ID)).notices.length, 1);
    });
    await t.test("long Retry-After delays and crash windows survive restart", async () => {
      time += EXAM_REFRESH_MS + 1;
      provider = () => new Response("", { status: 429, headers: { "Retry-After": "172800" } });
      await http();
      for (let n = 0; logs.at(-1) !== "rate_limit" && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
      // Log precedes the final cache write; await the durable timestamp too.
      for (let n = 0; n < 100; n++) {
        if ((await ExamNotificationCache.findById(EXAM_FEED_ID)).nextAttemptAt.getTime() === time + 172800000) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const before = calls; time += EXAM_REFRESH_MS + 1; await make().get(); assert.equal(calls, before);
      assert.equal((await ExamNotificationCache.findById(EXAM_FEED_ID)).nextAttemptAt.getTime() > time, true);
    });
  } finally {
    delete app.locals.examNotificationService;
    await new Promise(resolve => server.close(resolve));
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
  }
});
