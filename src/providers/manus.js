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
import { handleStatefulManusChat } from "./manus-sidecar.js";
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
  return handleStatefulManusChat(request, env, params, manusModel);
}
