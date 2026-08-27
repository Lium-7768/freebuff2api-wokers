import assert from "node:assert/strict";
import { test } from "node:test";
import {
  models,
  isConfigured,
  tokenHarborRequestParams,
} from "../src/providers/tokenharbor.js";

test("defines the TokenHarbor DeepSeek free model and configuration contract", () => {
  assert.deepEqual(models, [
    {
      id: "tokenharbor/qwen3.8-27b:free",
      upstream: "qwen3.8-27b:free",
      owned_by: "tokenharbor",
    },
    {
      id: "tokenharbor/deepseek-v4-flash:free",
      upstream: "deepseek-v4-flash:free",
      owned_by: "tokenharbor",
    },
    {
      id: "tokenharbor/mimo-v2.5:free",
      upstream: "mimo-v2.5:free",
      owned_by: "tokenharbor",
    },
  ]);
  assert.equal(isConfigured({ TOKENHARBOR_API_KEY: "key" }), true);
  assert.equal(isConfigured({ TOKENHARBOR_API_KEY: "" }), false);
});

test("maps the public model id and removes internal gateway fields", () => {
  const params = tokenHarborRequestParams({
    model: "tokenharbor/deepseek-v4-flash:free",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    __harness_mode: true,
    __harness_session_id: "private-session",
  }, models[1]);
  assert.equal(params.model, "deepseek-v4-flash:free");
  assert.equal(params.__harness_mode, undefined);
  assert.equal(params.__harness_session_id, undefined);
  assert.equal(params.stream, true);
  assert.deepEqual(params.messages, [{ role: "user", content: "hello" }]);
});
