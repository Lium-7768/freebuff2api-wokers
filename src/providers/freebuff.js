export const providerId = "freebuff";
export const ownedBy = "freebuff";
export const models = [
  { id: "deepseek/deepseek-v4-pro", session: "deepseek/deepseek-v4-pro", agent: "base3-free-deepseek", upstream: "deepseek/deepseek-v4-pro" },
  { id: "deepseek/deepseek-v4-flash", session: "deepseek/deepseek-v4-flash", agent: "base3-free-deepseek-flash", upstream: "deepseek/deepseek-v4-flash" },
  { id: "openai/gpt-5.6-luna", session: "openai/gpt-5.6-luna", agent: "base3-free-luna", upstream: "openai/gpt-5.6-luna" },
  { id: "minimax/minimax-m3", session: "minimax/minimax-m3", agent: "base3-free-minimax-m3", upstream: "minimax/minimax-m3" },
  { id: "mimo/mimo-v2.5", session: "mimo/mimo-v2.5", agent: "base3-free-mimo", upstream: "mimo/mimo-v2.5" },
];
export const premiumModels = new Set(["deepseek/deepseek-v4-pro", "openai/gpt-5.6-luna", "minimax/minimax-m3"]);
export const standardModels = new Set(["deepseek/deepseek-v4-flash", "mimo/mimo-v2.5"]);
export function isConfigured(env) { return Boolean(String(env?.FREEBUFF_API_KEY || env?.API_KEY || "").trim()); }
