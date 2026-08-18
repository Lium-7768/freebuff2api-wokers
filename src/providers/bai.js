export const providerId = "bai";
export const ownedBy = "bai";
export const models = [{ id: "bai/deepseek-v4-flash", upstream: "deepseek-v4-flash", owned_by: "bai" }];
export function isConfigured(env) { return Boolean(String(env?.BAI_API_KEY || "").trim()); }
export function baseUrl(env) { return String(env?.BAI_API_BASE || "https://api.b.ai").replace(/\/$/, ""); }
import { jsonResponse, corsHeaders } from "../protocol/compat.js";
export async function handleBaiChat(request, env, params, baiModel) {
  const apiKey = String(env.BAI_API_KEY || "").trim();
  if (!apiKey) return jsonResponse({ error: { message: "B.AI is not configured", type: "config_error" } }, 503);
  const base = String(env.BAI_API_BASE || "https://api.b.ai").replace(/\/$/, "");
  const upstreamParams = { ...params, model: baiModel.upstream };
  delete upstreamParams.__harness_mode;
  delete upstreamParams.__harness_session_id;
  let response;
  try {
    response = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json", "Accept": params.stream ? "text/event-stream" : "application/json" },
      body: JSON.stringify(upstreamParams),
      signal: request.signal,
    });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return jsonResponse({ error: { message: "B.AI upstream transport error: " + message, type: "upstream_transport_error" } }, 502);
  }
  const headers = { "Cache-Control": params.stream ? "no-cache" : "no-store", ...corsHeaders() };
  headers["Content-Type"] = params.stream ? "text/event-stream" : (response.headers.get("content-type") || "application/json");
  return new Response(response.body, { status: response.status, headers });
}
