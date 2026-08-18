export function openaiError(provider, message, type = "upstream_error", status = 502) {
  const error = { error: { message: `[${provider}] ${message}`, type, provider } };
  return new Response(JSON.stringify(error), { status, headers: { "Content-Type": "application/json" } });
}
