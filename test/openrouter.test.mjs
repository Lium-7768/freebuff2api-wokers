import test from "node:test";
import assert from "node:assert/strict";
import { models, isConfigured, openRouterRequestParams } from "../src/providers/openrouter.js";

test("defines the OpenRouter stealth model and configuration contract", () => {
  assert.deepEqual(models, [{
    id: "openrouter/stealth/ox-alpha",
    upstream: "stealth/ox-alpha",
    owned_by: "openrouter",
  }]);
  assert.equal(isConfigured({ OPENROUTER_API_KEY: "key" }), true);
  assert.equal(isConfigured({ OPENROUTER_API_KEY: "" }), false);
});

test("maps the public model id and removes internal gateway fields", () => {
  const params = openRouterRequestParams({
    model: "openrouter/stealth/ox-alpha",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    __harness_mode: true,
    __harness_session_id: "private-session",
  }, models[0]);
  assert.equal(params.model, "stealth/ox-alpha");
  assert.equal(params.__harness_mode, undefined);
  assert.equal(params.__harness_session_id, undefined);
  assert.equal(params.stream, true);
  assert.deepEqual(params.messages, [{ role: "user", content: "hello" }]);
});
