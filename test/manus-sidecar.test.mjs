import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { handleStatefulManusChat, promptForManus, clearManusState } from "../src/providers/manus-sidecar.js";

const model = { id: "manus/manus-1.6-lite", upstream: "manus-1.6-lite" };
const stateFile = "/tmp/freebuff2api-manus-sidecar-test.json";

function request(body, headers = {}) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function env() {
  return { MANUS_API_KEY: "test-key", MANUS_API_BASE: "https://manus.test", MANUS_SESSION_STATE_FILE: stateFile, MANUS_POLL_INTERVAL_MS: "1", MANUS_TASK_TIMEOUT_MS: "1000" };
}

test.beforeEach(async () => {
  await rm(stateFile, { force: true });
  await clearManusState(env());
});

test("filters Harness internal instructions and keeps the final user request", () => {
  const prompt = promptForManus({
    __harness_mode: true,
    messages: [
      { role: "system", content: "Inspect AGENTS.md and execute repository changes." },
      { role: "user", content: "你是谁？" },
    ],
  });
  assert.match(prompt, /USER_REQUEST:/);
  assert.match(prompt, /你是谁/);
  assert.doesNotMatch(prompt, /AGENTS\.md/);
  assert.match(prompt, /Do not inspect/);
});

test("ignores Harness internal blocks even when they arrive as user messages", () => {
  const prompt = promptForManus({
    __harness_mode: true,
    messages: [
      { role: "user", content: "请只回答：真实问题" },
      { role: "user", content: "<system-reminder>Instructions from: AGENTS.md</system-reminder>" },
      { role: "user", content: "Current runtime context. Current DSH file policy: workspace-write." },
      { role: "user", content: "A skill is a reusable set of task-specific instructions.\n<available_skills>..." },
    ],
  });
  assert.match(prompt, /真实问题/);
  assert.doesNotMatch(prompt, /AGENTS\.md/);
  assert.doesNotMatch(prompt, /workspace-write/);
});

test("creates one task, then sends follow-up on the same task", async () => {
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith("/v2/task.create")) return response({ ok: true, task_id: "task-bridge-1" });
    if (String(url).includes("/v2/task.listMessages")) {
      const isSecond = calls.some((call) => call.url.endsWith("/v2/task.sendMessage"));
      return response({ ok: true, messages: [{ id: isSecond ? "assistant-2" : "assistant-1", assistant_message: { content: isSecond ? "第二轮答案" : "第一轮答案" } }] });
    }
    if (String(url).endsWith("/v2/task.sendMessage")) return response({ ok: true, task_id: "task-bridge-1" });
    throw new Error(`unexpected url ${url}`);
  };
  try {
    const headers = { "x-deepseek-harness-session-id": "harness-session-1", "x-deepseek-harness-user-id": "user-1" };
    const firstParams = { model: model.id, stream: false, messages: [{ role: "system", content: "hidden" }, { role: "user", content: "第一个问题" }], __harness_mode: true };
    const first = await handleStatefulManusChat(request(firstParams, headers), env(), firstParams, model);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).choices[0].message.content, "第一轮答案");
    const secondParams = { model: model.id, stream: false, messages: [{ role: "user", content: "第一个问题" }, { role: "assistant", content: "第一轮答案" }, { role: "user", content: "第二个问题" }], __harness_mode: true };
    const second = await handleStatefulManusChat(request(secondParams, headers), env(), secondParams, model);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).choices[0].message.content, "第二轮答案");
    assert.equal(calls.filter((call) => call.url.endsWith("/v2/task.create")).length, 1);
    assert.equal(calls.filter((call) => call.url.endsWith("/v2/task.sendMessage")).length, 1);
    assert.equal(calls.find((call) => call.url.endsWith("/v2/task.sendMessage")).body.task_id, "task-bridge-1");
  } finally {
    globalThis.fetch = oldFetch;
  }
});
