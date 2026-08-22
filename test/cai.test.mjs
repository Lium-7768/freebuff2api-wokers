import test from "node:test";
import assert from "node:assert/strict";
import { models, isConfigured, baseUrl } from "../src/providers/cai.js";
import { resolveProviderModel } from "../src/router.js";

test("defines the independent C.AI model route", () => {
  assert.deepEqual(models, [
    {
      id: "cai/deepseek-v4-flash",
      upstream: "deepseek-v4-flash",
      owned_by: "cai",
    },
    {
      id: "cai/deepseek-v4-flash-vision-exp",
      upstream: "deepseek-v4-flash-vision-exp",
      owned_by: "cai",
    },
  ]);
  assert.equal(resolveProviderModel("cai/deepseek-v4-flash").provider, "cai");
  assert.equal(isConfigured({ CAI_API_KEY: "key" }), true);
  assert.equal(isConfigured({ CAI_API_KEY: "" }), false);
  assert.equal(baseUrl({}), "https://api.b.ai");
});
