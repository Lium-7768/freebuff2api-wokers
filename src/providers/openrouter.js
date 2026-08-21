import { jsonResponse, corsHeaders } from "../protocol/compat.js";

export const providerId = "openrouter";
export const ownedBy = "openrouter";
export const models = [
  { id: "openrouter/stealth/ox-alpha", upstream: "stealth/ox-alpha", owned_by: "openrouter" },
];

export function isConfigured(env) {
  return Boolean(String(env?.OPENROUTER_API_KEY || "").trim());
}

export function baseUrl(env) {
  return String(env?.OPENROUTER_API_BASE || "https://openrouter.ai/api/v1").replace(/\/$/, "");
}

export function openRouterRequestParams(params, model) {
  const upstream = { ...params, model: model.upstream };
  delete upstream.__harness_mode;
  delete upstream.__harness_session_id;
  return upstream;
}

export async function handleOpenRouterChat(request, env, params, model) {
  const apiKey = String(env?.OPENROUTER_API_KEY || "").trim();
  if (!apiKey) {
    return jsonResponse({ error: { message: "OpenRouter is not configured", type: "config_error" } }, 503);
  }

  let response;
  try {
    response = await fetch(`${baseUrl(env)}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: params.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(openRouterRequestParams(params, model)),
      signal: request.signal,
    });
  } catch (error) {
    return jsonResponse({
      error: {
        message: `OpenRouter upstream transport error: ${error?.message || error}`,
        type: "upstream_transport_error",
      },
    }, 502);
  }

  const headers = {
    "Cache-Control": params.stream ? "no-cache" : "no-store",
    ...corsHeaders(),
    "Content-Type": params.stream ? "text/event-stream" : (response.headers.get("content-type") || "application/json"),
  };
  return new Response(response.body, { status: response.status, headers });
}
