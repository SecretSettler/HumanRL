export interface ProviderRegistryEntry {
  provider: "openai" | "deepseek";
  model: string;
  checkedAt: "2026-08-03";
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  source: string;
}

export const ProviderRegistry: readonly ProviderRegistryEntry[] = Object.freeze([
  {
    provider: "openai",
    model: "gpt-5.6-sol",
    checkedAt: "2026-08-03",
    inputUsdPerMillion: 5,
    outputUsdPerMillion: 30,
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    checkedAt: "2026-08-03",
    inputUsdPerMillion: 0.14,
    outputUsdPerMillion: 0.28,
    source: "https://api-docs.deepseek.com/quick_start/pricing/",
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    checkedAt: "2026-08-03",
    inputUsdPerMillion: 0.435,
    outputUsdPerMillion: 0.87,
    source: "https://api-docs.deepseek.com/quick_start/pricing/",
  },
]);

export function calculateProviderCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const entry = ProviderRegistry.find(
    (candidate) => candidate.provider === provider && candidate.model === model,
  );
  if (!entry) return null;
  return (
    (inputTokens * entry.inputUsdPerMillion + outputTokens * entry.outputUsdPerMillion) / 1_000_000
  );
}
