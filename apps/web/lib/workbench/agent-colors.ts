const AGENT_COLORS = [
  "var(--color-accent)",
  "var(--color-cyan)",
  "var(--color-accent-2)",
  "var(--color-pink)",
  "var(--color-amber)",
  "var(--color-green)",
];

export const UNASSIGNED_LANE = "__unassigned__";

/** Stable colour per agent so Graph lanes and Gantt lanes agree. */
export function agentColor(order: readonly string[], agentId: string | null): string {
  const index = order.indexOf(agentId ?? UNASSIGNED_LANE);
  if (index < 0) return "var(--color-muted-2)";
  return AGENT_COLORS[index % AGENT_COLORS.length]!;
}

/**
 * Lane order for a trace: timeline agents first (their snapshot order), then
 * any agent that only appears on semantic nodes, then the unassigned bucket.
 */
export function laneOrderFor(
  timelineAgentIds: readonly string[],
  nodeAgentIds: readonly (string | null)[],
): string[] {
  const order: string[] = [...timelineAgentIds];
  let needsUnassigned = false;
  for (const agentId of nodeAgentIds) {
    if (agentId === null) {
      needsUnassigned = true;
      continue;
    }
    if (!order.includes(agentId)) order.push(agentId);
  }
  if (needsUnassigned) order.push(UNASSIGNED_LANE);
  return order;
}
