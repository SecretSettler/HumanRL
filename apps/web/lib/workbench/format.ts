export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatDurationBetween(startIso: string | null, endIso: string | null): string {
  if (!startIso || !endIso) return "—";
  return formatDurationMs(new Date(endIso).getTime() - new Date(startIso).getTime());
}

export function formatCostUsd(costs: readonly (string | null)[]): string | null {
  const known = costs.filter((cost): cost is string => cost !== null);
  if (known.length === 0) return null;
  const total = known.reduce((sum, cost) => sum + Number(cost), 0);
  return `$${total.toFixed(total < 0.1 ? 3 : 2)}`;
}
