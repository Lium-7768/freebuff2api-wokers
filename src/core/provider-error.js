export function providerError(provider, message, type = "upstream_error", status = 502, details = {}) {
  return { error: { message: `[${provider}] ${message}`, type, provider, ...details }, status };
}
export function upstreamStatus(status) {
  if (status === 400 || status === 401 || status === 403 || status === 408 || status === 409 || status === 422 || status === 429) return status;
  if (status === 404 || status >= 500) return 502;
  return 502;
}
