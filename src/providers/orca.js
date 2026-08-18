export const providerId = "orca";
export const ownedBy = "orca";
export const models = [{ id: "orca/deepseek/deepseek-v4-flash-free", upstream: "deepseek/deepseek-v4-flash-free", owned_by: "orca" }];
export function isConfigured(env) { return Boolean(String(env?.ORCA_API_KEY || "").trim()); }
export function baseUrl(env) { return String(env?.ORCA_API_BASE || "https://api.orcarouter.ai/v1").replace(/\/$/, ""); }
import { jsonResponse, corsHeaders } from "../protocol/compat.js";
export function orcaRequestParams(params, orcaModel, env) {
  const upstreamParams = { ...params, model: orcaModel.upstream };
  const mode = String(env?.FREEBUFF_ORCA_REQUEST_MODE || "harness-compact")
    .trim().toLowerCase();
  if (mode === "off" || !params.__harness_mode) return upstreamParams;

  // Compact only the Harness route. Ordinary OpenAI clients keep their
  // original request shape. Orca free endpoints reject large agent payloads.
  const messages = Array.isArray(params.messages) ? params.messages : [];
  upstreamParams.messages = messages
    .filter((message) => message && ["user", "assistant"].includes(message.role)
      && message.content !== undefined && message.content !== null)
    .slice(-2)
    .map(({ role, content }) => ({ role, content }));
  delete upstreamParams.system;
  delete upstreamParams.tools;
  delete upstreamParams.tool_choice;
  delete upstreamParams.parallel_tool_calls;
  if (upstreamParams.max_tokens !== undefined) {
    const value = Number(upstreamParams.max_tokens);
    upstreamParams.max_tokens = Number.isFinite(value)
      ? Math.min(Math.max(1, value), 512)
      : 512;
  } else if (upstreamParams.max_completion_tokens !== undefined) {
    const value = Number(upstreamParams.max_completion_tokens);
    upstreamParams.max_completion_tokens = Number.isFinite(value)
      ? Math.min(Math.max(1, value), 512)
      : 512;
  } else {
    upstreamParams.max_tokens = 512;
  }
  return upstreamParams;
}

export async function handleOrcaChat(request, env, params, orcaModel) {
  const apiKey = String(env.ORCA_API_KEY || "").trim();
  if (!apiKey) return jsonResponse({ error: { message: "Orca Router is not configured", type: "config_error" } }, 503);
  const base = String(env.ORCA_API_BASE || "https://api.orcarouter.ai/v1").replace(/\/$/, "");
  const upstreamParams = orcaRequestParams(params, orcaModel, env);
  let response;
  try {
    response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json", "Accept": params.stream ? "text/event-stream" : "application/json" },
      body: JSON.stringify(upstreamParams),
      signal: request.signal,
    });
  } catch (error) {
    return jsonResponse({ error: { message: `Orca upstream transport error: ${error?.message || error}`, type: "upstream_transport_error" } }, 502);
  }
  const headers = { "Cache-Control": params.stream ? "no-cache" : "no-store", ...corsHeaders() };
  headers["Content-Type"] = params.stream ? "text/event-stream" : (response.headers.get("content-type") || "application/json");
  return new Response(response.body, { status: response.status, headers });
}

