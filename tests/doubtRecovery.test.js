import test from "node:test";
import assert from "node:assert/strict";
import { doubtReadiness } from "../services/doubtReadiness.js";
import { answerWithDeadline } from "../services/doubtAnswerDeadline.js";

test("readiness distinguishes unpublished material, indexing, failure and service configuration", () => {
  const state = { enabled: true, configured: true, documents: [] };
  const status = changes => doubtReadiness({ ...state, ...changes }).code;
  assert.equal(status({}), "no_material");
  assert.equal(status({ documents: [{ status: "removing", published: false }] }), "no_material");
  for (const processing of ["uploading", "queued", "indexing"]) assert.equal(status({ documents: [{ status: processing }] }), "indexing");
  assert.equal(status({ documents: [{ status: "failed" }] }), "indexing_failed");
  assert.equal(status({ documents: [{ status: "ready", searchVersion: 1, published: false }] }), "awaiting_publication");
  const documents = [{ status: "ready", searchVersion: 1, published: true }, { status: "indexing" }, { status: "failed" }];
  assert.equal(status({ documents }), "ready", "another upload must not block existing published material");
  assert.equal(status({ documents: [{ status: "ready", published: true }] }), "indexing");
  assert.equal(status({ documents, enabled: false }), "paused");
  assert.equal(status({ documents, configured: false }), "service_unavailable");
  assert.equal(documents[0].published, true);
});

test("a stalled provider is aborted once and late completion cannot replace the timeout", async () => {
  let calls = 0, signal, finish;
  const provider = { answer: args => { calls++; signal = args.signal; return new Promise(resolve => { finish = resolve; }); } };
  await assert.rejects(answerWithDeadline(provider, {}, 15), error => error.statusCode === 504);
  assert.equal(signal.aborted, true); assert.equal(calls, 1);
  finish({ answer: "Too late" });
  assert.deepEqual(await answerWithDeadline({ answer: async () => ({ answer: "Ready" }) }, {}, 100), { answer: "Ready" });
  await assert.rejects(answerWithDeadline({ answer: async () => { throw new Error("Provider failure"); } }, {}, 100), /Provider failure/);
});
