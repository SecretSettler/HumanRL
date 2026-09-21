import { createHash } from "node:crypto";

import { SchemaVersion, type RawTraceEvent, type RawTraceEventInput } from "@intenttrace/schema";

export const acceptanceFixtureManifest = {
  id: "six-agent-repair-v1",
  seed: 20260801,
  minimumEventCount: 2000,
  agents: ["orchestrator", "research", "backend", "frontend", "summarizer", "test"],
  requiredNarrative: [
    "parallel",
    "handoff",
    "malformed_trace_id",
    "failure",
    "repair",
    "join",
    "final_result",
  ],
  implementationGate: 1,
} as const;

export const foundationRawEvent: RawTraceEvent = {
  schemaVersion: SchemaVersion,
  id: "019fbbb3-4324-7d43-8f9c-cd489a92cb28",
  workspaceId: "019fbbb3-4324-7d43-8f9c-cd489a92cb29",
  projectId: "019fbbb3-4324-7d43-8f9c-cd489a92cb30",
  traceId: "019fbbb3-4324-7d43-8f9c-cd489a92cb31",
  source: {
    kind: "jsonl",
    formatVersion: "1",
    adapterVersion: "0.0.0",
    sourceInstanceId: "foundation-fixture",
    sourceEventId: "request-1",
  },
  ingestSeq: "1",
  occurredAt: "2026-08-01T00:00:00.000Z",
  ingestedAt: "2026-08-01T00:00:00.001Z",
  kind: "user_message",
  name: "Request IntentTrace foundation",
  status: "ok",
  artifactRefs: [],
  attributes: {},
};

function fixtureUuid(value: string): string {
  const bytes = createHash("sha256")
    .update(`intenttrace-fixture:${value}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function generateAcceptanceFixture(eventCount = 2048): RawTraceEventInput[] {
  if (
    !Number.isSafeInteger(eventCount) ||
    eventCount < acceptanceFixtureManifest.minimumEventCount
  ) {
    throw new RangeError(
      `eventCount must be at least ${acceptanceFixtureManifest.minimumEventCount}`,
    );
  }
  const workspaceId = fixtureUuid("workspace");
  const projectId = fixtureUuid("project");
  const traceId = fixtureUuid("trace");
  const agents = acceptanceFixtureManifest.agents;
  const events: RawTraceEventInput[] = [];

  for (let index = 0; index < eventCount; index += 1) {
    const agentId = agents[index % agents.length]!;
    const isFinal = index === eventCount - 1;
    const isFailure = index === 701;
    const isRepair = index === 733;
    const isHandoff = index > 0 && index % 97 === 0;
    const kind = isFinal
      ? "trace_complete"
      : isFailure
        ? "error"
        : isRepair
          ? "correction"
          : isHandoff
            ? "agent_handoff"
            : index % 11 === 0
              ? "tool_call"
              : index % 11 === 1
                ? "tool_result"
                : "log";
    events.push({
      schemaVersion: SchemaVersion,
      workspaceId,
      projectId,
      traceId,
      workspaceName: "Acceptance workspace",
      projectName: "Six-agent repair fixture",
      traceTitle: "Deterministic six-agent repair and join",
      source: {
        kind: "jsonl",
        formatVersion: "1.0.0",
        adapterVersion: "1.0.0",
        sourceInstanceId: "six-agent-repair-v1",
        sourceEventId: `event-${String(index + 1).padStart(4, "0")}`,
      },
      occurredAt: new Date(Date.UTC(2026, 7, 1, 0, 0, 0, index * 10)).toISOString(),
      kind,
      name: isFinal
        ? "Joined final result"
        : isFailure
          ? "Backend validation failed"
          : isRepair
            ? "Backend validation repaired"
            : isHandoff
              ? `Handoff from ${agentId}`
              : `Fixture event ${index + 1}`,
      status: isFailure ? "error" : "ok",
      agentId,
      spanId: `span-${Math.floor(index / 4)}`,
      ...(index >= 4 ? { parentSpanId: `span-${Math.floor((index - 4) / 4)}` } : {}),
      artifactRefs: [],
      attributes: {
        fixture: acceptanceFixtureManifest.id,
        seed: acceptanceFixtureManifest.seed,
        parallelLane: index % agents.length,
        ...(index === 509 ? { malformedTraceIdObserved: "not-a-valid-id" } : {}),
        ...(isFinal ? { joinedAgents: [...agents] } : {}),
      },
      payload: { ordinal: index + 1, synthetic: true },
    });
  }
  return events;
}
