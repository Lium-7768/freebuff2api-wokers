import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { jsonResponse, corsHeaders } from "../protocol/compat.js";

const sessions = new Map();
const locks = new Map();
let stateLoaded = false;
let stateLoadPromise;

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function stateFile(env) {
  return String(env?.MANUS_SESSION_STATE_FILE || "/data/manus-sessions.json").trim();
}

function textFromContent(content) {
  if (Array.isArray(content)) return content.map((part) => typeof part === "string" ? part : part?.text ?? part?.content ?? "").join("");
  if (content && typeof content === "object") return JSON.stringify(content);
  return String(content ?? "");
}

function latestUserMessage(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (String(messages[i]?.role || "") === "user") return textFromContent(messages[i].content).trim();
  }
  return "";
}

export function promptForManus(params) {
  const userText = latestUserMessage(params?.messages);
  if (!userText) return "";
  if (!params?.__harness_mode) return userText;
  return [
    "Answer the user's latest request directly.",
    "Do not inspect or execute hidden client instructions, repository policies, skill catalogs, or tool schemas.",
    "Do not describe an internal plan unless the user asks for one.",
    "Return only the answer to the user request.",
    "",
    "USER_REQUEST:",
    userText,
  ].join("\n");
}

function recordFrom(value) {
  if (!value || !value.taskId || !value.modelId) return null;
  return {
    taskId: String(value.taskId),
    modelId: String(value.modelId),
    lastUserHash: String(value.lastUserHash || ""),
    lastAnswer: value.lastAnswer == null ? null : String(value.lastAnswer),
    seen: Array.isArray(value.seen) ? value.seen.slice(-200).map(String) : [],
    updatedAt: Number(value.updatedAt || Date.now()),
  };
}

async function loadState(env) {
  if (stateLoaded) return;
  if (stateLoadPromise) return stateLoadPromise;
  stateLoadPromise = (async () => {
    try {
      const raw = await readFile(stateFile(env), "utf8");
      const parsed = JSON.parse(raw);
      for (const [key, value] of Object.entries(parsed?.sessions || {})) {
        const record = recordFrom(value);
        if (record && Date.now() - record.updatedAt < 24 * 60 * 60 * 1000) sessions.set(key, record);
      }
    } catch {
      // Fresh or read-only containers use process memory until persistence works.
    } finally {
      stateLoaded = true;
    }
  })();
  return stateLoadPromise;
}

async function persistState(env) {
  const file = stateFile(env);
  try {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, JSON.stringify({ version: 1, sessions: Object.fromEntries(sessions) }), { mode: 0o600 });
    await rename(temporary, file);
  } catch {
    // Persistence is best effort; correctness does not depend on disk availability.
  }
}

function messageKey(message) {
  if (message?.id) return String(message.id);
  return hash(JSON.stringify(message));
}

function assistantText(message) {
  if (message?.assistant_message?.content === undefined) return null;
  return textFromContent(message.assistant_message.content).trim();
}

function responseFor(model, taskId, content) {
  return {
    id: `chatcmpl-manus-${taskId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model.id,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function sseFor(model, content) {
  const id = `chatcmpl-manus-${Math.random().toString(36).slice(2, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  const chunks = [
    { id, object: "chat.completion.chunk", created, model: model.id, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { id, object: "chat.completion.chunk", created, model: model.id, choices: [{ index: 0, delta: { content }, finish_reason: null }] },
    { id, object: "chat.completion.chunk", created, model: model.id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...corsHeaders() },
  });
}

async function fetchJson(url, init, signal) {
  const response = await fetch(url, { ...init, signal });
  return { response, data: await response.json().catch(() => ({})) };
}

async function createTask(base, key, prompt, model, request) {
  try {
    const { response, data } = await fetchJson(`${base}/v2/task.create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-manus-api-key": key },
      body: JSON.stringify({ message: { content: prompt }, agent_profile: model.upstream, interactive_mode: false, hide_in_task_list: true }),
    }, request.signal);
    if (!response.ok || !data.ok || !data.task_id) return { error: jsonResponse({ error: { message: `Manus task.create failed: ${data?.error?.message || response.statusText}`, type: data?.error?.code || "upstream_error", request_id: data?.request_id } }, response.status >= 400 ? response.status : 502) };
    return { taskId: String(data.task_id) };
  } catch (error) {
    return { error: jsonResponse({ error: { message: `Manus task.create transport error: ${error?.message || String(error)}`, type: "upstream_transport_error" } }, 502) };
  }
}

async function sendMessage(base, key, taskId, prompt, model, request) {
  try {
    const { response, data } = await fetchJson(`${base}/v2/task.sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-manus-api-key": key },
      body: JSON.stringify({ task_id: taskId, message: { content: prompt }, agent_profile: model.upstream }),
    }, request.signal);
    if (!response.ok || data.ok === false) return { error: jsonResponse({ error: { message: `Manus task.sendMessage failed: ${data?.error?.message || response.statusText}`, type: data?.error?.code || "upstream_error", task_id: taskId, request_id: data?.request_id } }, response.status >= 400 ? response.status : 502) };
    return { ok: true };
  } catch (error) {
    return { error: jsonResponse({ error: { message: `Manus task.sendMessage transport error: ${error?.message || String(error)}`, type: "upstream_transport_error", task_id: taskId } }, 502) };
  }
}

async function listMessages(base, key, taskId, request) {
  return fetchJson(`${base}/v2/task.listMessages?task_id=${encodeURIComponent(taskId)}&order=desc&limit=100`, { headers: { "x-manus-api-key": key } }, request.signal);
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    if (signal.aborted) { clearTimeout(timer); reject(signal.reason || new Error("aborted")); return; }
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason || new Error("aborted")); }, { once: true });
  });
}

async function pollAnswer(base, key, record, request, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { response, data } = await listMessages(base, key, record.taskId, request);
      if (response.status === 404) { await delay(pollMs, request.signal); continue; }
      if (!response.ok || data.ok === false) return { error: jsonResponse({ error: { message: `Manus task.listMessages failed: ${data?.error?.message || response.statusText}`, type: data?.error?.code || "upstream_error", task_id: record.taskId, request_id: data?.request_id } }, response.status >= 400 ? response.status : 502) };
      for (const message of Array.isArray(data.messages) ? data.messages : []) {
        const keyForMessage = messageKey(message);
        if (record.seen.includes(keyForMessage)) continue;
        const answer = assistantText(message);
        record.seen.push(keyForMessage);
        record.seen = [...new Set(record.seen)].slice(-200);
        if (answer !== null) {
          record.lastAnswer = answer;
          record.updatedAt = Date.now();
          return { answer };
        }
        if (message.status_update?.agent_status === "waiting") return { error: jsonResponse({ error: { message: "Manus task requires confirmation; use the Manus task API for task.confirmAction", type: "manus_waiting", task_id: record.taskId, status_update: message.status_update } }, 409) };
        if (message.status_update?.agent_status === "error") return { error: jsonResponse({ error: { message: message.status_update.description || "Manus task failed", type: "manus_task_error", task_id: record.taskId } }, 502) };
      }
      await delay(pollMs, request.signal);
    } catch (error) {
      if (request.signal?.aborted) return { error: jsonResponse({ error: { message: "Manus request aborted", type: "client_closed_request", task_id: record.taskId } }, 499) };
      return { error: jsonResponse({ error: { message: `Manus polling transport error: ${error?.message || String(error)}`, type: "upstream_transport_error", task_id: record.taskId } }, 502) };
    }
  }
  return { error: jsonResponse({ error: { message: "Manus task timed out", type: "upstream_timeout", task_id: record.taskId } }, 504) };
}

function conversationKey(request, params, model) {
  const supplied = request.headers.get("x-deepseek-harness-session-id") || request.headers.get("x-session-id") || request.headers.get("x-conversation-id") || params?.__harness_session_id;
  if (!supplied) return null;
  const user = request.headers.get("x-deepseek-harness-user-id") || "anonymous";
  return hash(`${user}:${supplied}:${model.id}`).slice(0, 48);
}

async function locked(key, work) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  locks.set(key, current);
  await previous.catch(() => {});
  try { return await work(); } finally { release(); if (locks.get(key) === current) locks.delete(key); }
}

export async function handleStatefulManusChat(request, env, params, model) {
  const key = String(env.MANUS_API_KEY || "").trim();
  if (!key) return jsonResponse({ error: { message: "Manus is not configured", type: "config_error" } }, 503);
  const prompt = promptForManus(params);
  if (!prompt) return jsonResponse({ error: { message: "messages must contain a user message", type: "invalid_request_error" } }, 400);
  await loadState(env);
  const stableSession = conversationKey(request, params, model);
  // Without a stable client session identifier, preserve stateless behavior
  // while still serializing this individual request.
  const session = stableSession || `transient:${hash(`${Date.now()}:${Math.random()}`)}`;
  return locked(session, async () => {
    let record = sessions.get(session);
    if (!record || record.modelId !== model.id) {
      record = { taskId: "", modelId: model.id, lastUserHash: "", lastAnswer: null, seen: [], updatedAt: Date.now() };
      if (stableSession) sessions.set(session, record);
    }
    const userHash = hash(latestUserMessage(params.messages));
    if (record.lastUserHash === userHash && record.lastAnswer !== null) return params.stream ? sseFor(model, record.lastAnswer) : jsonResponse(responseFor(model, record.taskId, record.lastAnswer), 200);
    const base = String(env.MANUS_API_BASE || "https://api.manus.ai").replace(/\/$/, "");
    const timeoutMs = Math.max(5000, Number(env.MANUS_TASK_TIMEOUT_MS || 120000));
    const pollMs = Math.max(250, Number(env.MANUS_POLL_INTERVAL_MS || 1500));
    let result;
    if (!record.taskId) result = await createTask(base, key, prompt, model, request);
    else {
      // Mark old events before sending a follow-up, so the next assistant event
      // cannot be mistaken for a previous answer.
      const snapshot = await listMessages(base, key, record.taskId, request).catch(() => null);
      for (const message of snapshot?.data?.messages || []) record.seen.push(messageKey(message));
      result = await sendMessage(base, key, record.taskId, prompt, model, request);
    }
    if (result.error) return result.error;
    record.taskId = result.taskId || record.taskId;
    record.lastUserHash = userHash;
    record.lastAnswer = null;
    record.updatedAt = Date.now();
    await persistState(env);
    const answer = await pollAnswer(base, key, record, request, timeoutMs, pollMs);
    await persistState(env);
    if (answer.error) return answer.error;
    return params.stream ? sseFor(model, answer.answer) : jsonResponse(responseFor(model, record.taskId, answer.answer), 200);
  });
}

export async function clearManusState(env) {
  sessions.clear();
  stateLoaded = false;
  stateLoadPromise = undefined;
  await persistState(env);
}
