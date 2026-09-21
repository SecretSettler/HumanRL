"use client";

import { formatCostUsd } from "@/lib/workbench/format";
import { useWorkbenchStore } from "@/lib/workbench/store";

export function BudgetCard() {
  const providerCalls = useWorkbenchStore((state) => state.providerCalls);
  const cost = formatCostUsd((providerCalls ?? []).map((call) => call.costUsd));

  return (
    <div className="rounded-[11px] border border-line bg-[#0d1118] p-3" data-testid="budget-card">
      <div className="flex items-baseline justify-between">
        <span className="text-micro font-semibold text-muted">Summary spend · this trace</span>
        <span className="text-body font-bold text-ink">{cost ?? "—"}</span>
      </div>
      <p className="m-0 mt-1.5 text-micro text-muted-2">
        {providerCalls === null
          ? "Loading provider calls…"
          : providerCalls.length > 0
            ? `${providerCalls.length} provider calls recorded`
            : "No summary spend recorded"}
      </p>
    </div>
  );
}
