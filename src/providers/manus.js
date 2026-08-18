export const providerId = "manus";
export const ownedBy = "manus";
export const models = [
  { id: "manus/manus-1.6", upstream: "manus-1.6", owned_by: "manus" },
  { id: "manus/manus-1.6-lite", upstream: "manus-1.6-lite", owned_by: "manus" },
];
export function isConfigured(env) { return Boolean(String(env?.MANUS_API_KEY || "").trim()); }
export function baseUrl(env) { return String(env?.MANUS_API_BASE || "https://api.manus.ai").replace(/\/$/, ""); }
export function maxEstimatedTokens(env) { return Math.max(1000, Math.min(4500, Number(env?.MANUS_MAX_ESTIMATED_TOKENS || 4500))); }
import { jsonResponse, corsHeaders } from "../protocol/compat.js";
export function manusTextFromMessages(messages, maxEstimatedTokens = 4500) {
  if (!Array.isArray(messages)) return String(messages || "");
  const maxChars = Math.max(4000, Math.min(19200, Number(maxEstimatedTokens || 4500) * 4));
  const entries = messages.map((message) => {
    const role = String(message?.role || "user");
    let content = message?.content;
    if (Array.isArray(content)) content = content.map((part) => part?.text ?? part?.content ?? "").join("");
    if (content && typeof content === "object") content = JSON.stringify(content);
    content = String(content ?? "");
    const block = role + ": " + content;
    if (block.length <= maxChars) return block;
    const keepHead = Math.floor(maxChars * 0.72);
    const keepTail = Math.max(256, maxChars - keepHead - 80);
    return block.slice(0, keepHead) + " [message content truncated by VPS adapter] " + block.slice(-keepTail);
  });
  const selected = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const block = entries[index];
    const extra = block.length + (selected.length ? 2 : 0);
    if (used + extra > maxChars) break;
    selected.unshift(block);
    used += extra;
  }
  if (!selected.length && entries.length) selected.unshift(entries.at(-1).slice(-maxChars));
  if (selected.length < entries.length) selected.unshift("[earlier messages omitted to stay within Manus 5000-token limit]");
  return selected.join("\n\n");
}
export function manusDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); reject(signal.reason || new Error("aborted")); return; }
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason || new Error("aborted")); }, { once: true });
    }
  });
}
export function manusSseResponse(model, content) {
  const id = "chatcmpl-manus-" + Math.random().toString(36).slice(2, 12);
  const created = Math.floor(Date.now() / 1000);
  const chunks = [
    { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content }, finish_reason: null }] },
    { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  const body = chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...corsHeaders() } });
}
export async function handleManusChat(request, env, params, manusModel) {
  const apiKey = String(env.MANUS_API_KEY || "").trim();
  if (!apiKey) return jsonResponse({ error: { message: "Manus is not configured", type: "config_error" } }, 503);
  const base = String(env.MANUS_API_BASE || "https://api.manus.ai").replace(/\/$/, "");
  const timeoutMs = Math.max(5000, Number(env.MANUS_TASK_TIMEOUT_MS || 120000));
  const pollMs = Math.max(250, Number(env.MANUS_POLL_INTERVAL_MS || 1500));
  const maxEstimatedTokens = Math.max(1000, Math.min(4500, Number(env.MANUS_MAX_ESTIMATED_TOKENS || 4500)));
  const content = manusTextFromMessages(params.messages, maxEstimatedTokens);
  if (!content.trim()) return jsonResponse({ error: { message: "messages cannot be empty", type: "invalid_request_error" } }, 400);
  const headers = { "Content-Type": "application/json", "x-manus-api-key": apiKey };
  let created;
  try {
    const response = await fetch(base + "/v2/task.create", { method: "POST", headers, body: JSON.stringify({ message: { content }, agent_profile: manusModel.upstream, interactive_mode: false, hide_in_task_list: true }), signal: request.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !data.task_id) return jsonResponse({ error: { message: data?.error?.message || "Manus task.create failed", type: data?.error?.code || "upstream_error", request_id: data?.request_id } }, response.status >= 400 ? response.status : 502);
    created = data;
  } catch (error) {
    return jsonResponse({ error: { message: "Manus task.create transport error: " + (error?.message || String(error)), type: "upstream_transport_error" } }, 502);
  }
  await manusDelay(250, request.signal);
  const deadline = Date.now() + timeoutMs;
  let answer = null;
  let waiting = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base + "/v2/task.listMessages?task_id=" + encodeURIComponent(created.task_id) + "&order=desc&limit=100", { headers: { "x-manus-api-key": apiKey }, signal: request.signal });
      if (response.status === 404) { await manusDelay(pollMs, request.signal); continue; }
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) return jsonResponse({ error: { message: data?.error?.message || "Manus task.listMessages failed", type: data?.error?.code || "upstream_error", task_id: created.task_id } }, response.status >= 400 ? response.status : 502);
      for (const message of Array.isArray(data.messages) ? data.messages : []) {
        if (message.assistant_message?.content !== undefined) { answer = String(message.assistant_message.content); break; }
        const status = message.status_update;
        if (status?.agent_status === "waiting") { waiting = status; break; }
        if (status?.agent_status === "error") return jsonResponse({ error: { message: status.description || "Manus task failed", type: "manus_task_error", task_id: created.task_id } }, 502);
      }
      if (answer !== null) break;
      if (waiting) break;
    } catch (error) {
      if (request.signal?.aborted) return jsonResponse({ error: { message: "Manus request aborted", type: "client_closed_request", task_id: created.task_id } }, 499);
      return jsonResponse({ error: { message: "Manus polling transport error: " + (error?.message || String(error)), type: "upstream_transport_error", task_id: created.task_id } }, 502);
    }
    await manusDelay(pollMs, request.signal);
  }
  if (waiting) return jsonResponse({ error: { message: "Manus task requires confirmation; use the Manus task API for task.confirmAction", type: "manus_waiting", task_id: created.task_id, status_update: waiting } }, 409);
  if (answer === null) return jsonResponse({ error: { message: "Manus task timed out", type: "upstream_timeout", task_id: created.task_id } }, 504);
  const result = { id: "chatcmpl-manus-" + created.task_id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: manusModel.id, choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
  return params.stream ? manusSseResponse(manusModel.id, answer) : jsonResponse(result, 200);
}
