import { providers } from "./providers/index.js";

const entries = [
  ["freebuff", providers.freebuff.models],
  ["orca", providers.orca.models],
  ["bai", providers.bai.models],
  ["manus", providers.manus.models],
];

export function resolveProviderModel(modelId) {
  const raw = String(modelId || "").trim();
  for (const [provider, models] of entries) {
    const model = models.find((item) => item.id === raw);
    if (model) return { provider, model };
  }
  return null;
}

export function modelsForProvider(provider, env) {
  const item = providers[provider];
  if (!item || !item.isConfigured(env)) return [];
  return item.models;
}
