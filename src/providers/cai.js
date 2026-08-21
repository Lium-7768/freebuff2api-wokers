import { jsonResponse, corsHeaders } from "../protocol/compat.js";

export const providerId = "cai";
export const ownedBy = "cai";
export const models = [{ id: "cai/deepseek-v4-flash", upstream: "deepseek-v4-flash", owned_by: "cai" }];

export function isConfigured(env) {
  return Boolean(String(env?.CAI_API_KEY || "").trim());
}

export function baseUrl(env) {
  return String(env?.CAI_API_BASE || "https://api.b.ai").replace(/\/$/, "");
}

export async function handleCaiChat(request, env, params, caiModel) {
  const apiKey = String(env?.CAI_API_KEY || "").trim();
  if (!apiKey) {
    return jsonResponse({ error: { message: "C.AI is not configured", type: "config_error" } }, 503);
  }
  const upstreamParams = { ...params, model: caiModel.upstream };
  delete upstreamParams.__harness_mode;
  delete upstreamParams.__harness_session_id;
  let response;
  try {
    response = await fetch(`${baseUrl(env)}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: params.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(upstreamParams),
      signal: request.signal,
    });
  } catch (error) {
    return jsonResponse({ error: { message: `C.AI upstream transport error: ${error?.message || error}`, type: "upstream_transport_error" } }, 502);
  }
  const headers = {
    "Cache-Control": params.stream ? "no-cache" : "no-store",
    ...corsHeaders(),
    "Content-Type": params.stream ? "text/event-stream" : (response.headers.get("content-type") || "application/json"),
  };
  return new Response(response.body, { status: response.status, headers });
}
