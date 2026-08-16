import assert from "node:assert/strict";
import { after, test } from "node:test";
import worker from "../worker.js";

const originalFetch = globalThis.fetch;
const apiKey = "admission-test-key";

after(() => { globalThis.fetch = originalFetch; });

function request() {
  return new Request("http://local.test/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "test" }],
      stream: false,
    }),
  });
}

function env(token) {
  return { FREEBUFF_CREDENTIALS_JSON: JSON.stringify({ accounts: { session: { authToken: token, fingerprintId: "fp-session" } } }), FREEBUFF_API_KEY: apiKey, FREEBUFF_DEBUG: "false" };
}

function installAdmissionMock(state, status, retryAfterMs) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const method = init.method || "GET";
    calls.push({ path, method });
    if (path === "/api/v1/freebuff/session" && method === "GET") {
      return Response.json({ status: "ended" });
    }
    if (path === "/api/v1/freebuff/session" && method === "POST") {
      return Response.json({ status: state, message: "mock " + state, retryAfterMs }, { status });
    }
    throw new Error("unexpected upstream request: " + method + " " + path);
  };
  return calls;
}

test("documented model_unavailable admission returns 409 before chat or delete", async () => {
  const calls = installAdmissionMock("model_unavailable", 409);
  const answer = await worker.fetch(request(), env("admission-model-unavailable-aaaaaaaa"));
  assert.equal(answer.status, 409);
  assert.equal(calls.some((item) => item.path === "/api/v1/chat/completions"), false);
  assert.equal(calls.some((item) => item.method === "DELETE"), false);
});

test("documented spend_limited admission preserves 429 retry-after without chat", async () => {
  const calls = installAdmissionMock("spend_limited", 429, 90_000);
  const answer = await worker.fetch(request(), env("admission-spend-limited-bbbbbbbb"));
  assert.equal(answer.status, 429);
  assert.equal(answer.headers.get("retry-after"), "90");
  assert.equal(calls.some((item) => item.path === "/api/v1/chat/completions"), false);
});
