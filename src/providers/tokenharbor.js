import { jsonResponse, corsHeaders } from "../protocol/compat.js";

export const providerId = "tokenharbor";
export const ownedBy = "tokenharbor";
export const models = [
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
];

export function isConfigured(env) {
  return Boolean(String(env?.TOKENHARBOR_API_KEY || "").trim());
}

export function baseUrl(env) {
  return String(env?.TOKENHARBOR_API_BASE || "https://tokenharbor.ai/v1").replace(/\/$/, "");
}

export function tokenHarborRequestParams(params, model) {
  const upstream = { ...params, model: model.upstream };
  delete upstream.__harness_mode;
  delete upstream.__harness_session_id;
  return upstream;
}

export async function handleTokenHarborChat(request, env, params, model) {
  const apiKey = String(env?.TOKENHARBOR_API_KEY || "").trim();
  if (!apiKey) {
    return jsonResponse({
      error: { message: "TokenHarbor is not configured", type: "config_error" },
    }, 503);
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
      body: JSON.stringify(tokenHarborRequestParams(params, model)),
      signal: request.signal,
    });
  } catch (error) {
    return jsonResponse({
      error: {
        message: `TokenHarbor upstream transport error: ${error?.message || error}`,
        type: "upstream_transport_error",
      },
    }, 502);
  }

  const headers = {
    "Cache-Control": params.stream ? "no-cache" : "no-store",
    ...corsHeaders(),
    "Content-Type": params.stream
      ? "text/event-stream"
      : (response.headers.get("content-type") || "application/json"),
  };
  return new Response(response.body, { status: response.status, headers });
}
