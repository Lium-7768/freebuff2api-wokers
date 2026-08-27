import test from "node:test";
import assert from "node:assert/strict";
import { resolveProviderModel } from "../src/router.js";

test("routes every supported external provider model", () => {
  assert.equal(resolveProviderModel("orca/deepseek/deepseek-v4-flash-free").provider, "orca");
  assert.equal(resolveProviderModel("bai/deepseek-v4-flash").provider, "bai");
  assert.equal(resolveProviderModel("bai/deepseek-v4-flash-vision-exp").provider, "bai");
  assert.equal(resolveProviderModel("cai/deepseek-v4-flash-vision-exp").provider, "cai");
  assert.equal(resolveProviderModel("manus/manus-1.6").provider, "manus");
  assert.equal(resolveProviderModel("manus/manus-1.6-lite").provider, "manus");
  assert.equal(resolveProviderModel("openrouter/stealth/ox-alpha").provider, "openrouter");
  assert.equal(resolveProviderModel("tokenharbor/deepseek-v4-flash:free").provider, "tokenharbor");
  assert.equal(resolveProviderModel("deepseek/deepseek-v4-flash").provider, "freebuff");
});

test("returns null for unknown model", () => {
  assert.equal(resolveProviderModel("unknown/vendor-model"), null);
});
