import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { RawTraceEventInputSchema } from "@intenttrace/schema";

const requiredChildren = [
  "ImoBruteForce",
  "ImoConstructions",
  "ImoImpossibility",
  "ImoVerifier",
  "ImoWriteup",
  "WebUiSurface",
  "IngestAndFixtures",
  "DocsConventions",
] as const;

const lines = readFileSync(
  new URL("../fixtures/demo/imo-2025-p1-parallel-solve.jsonl", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter((line) => line.trim().length > 0);
const events = lines.map((line) => RawTraceEventInputSchema.parse(JSON.parse(line)));

describe("recorded topology demo acceptance", () => {
  it("captures every required external lane and its canonical topology facts", () => {
    const childStarts = events.filter((event) => event.kind === "agent_start");
    const childEnds = events.filter((event) => event.kind === "agent_end");
    const dispatches = events.filter(
      (event) =>
        event.agentId === "Orchestrator" && Array.isArray(event.attributes.spawnedAgentIds),
    );
    const joins = events.filter(
      (event) => event.agentId === "Orchestrator" && Array.isArray(event.attributes.joinedAgentIds),
    );
    const childIds = new Set(childStarts.map((event) => event.agentId));
    const spawnedIds = new Set(
      dispatches.flatMap((event) => event.attributes.spawnedAgentIds as string[]),
    );
    const endedIds = new Set(childEnds.map((event) => event.agentId));
    const joinedIds = new Set(
      joins.flatMap((event) => event.attributes.joinedAgentIds as string[]),
    );

    expect(new Set(events.map((event) => event.agentId).filter(Boolean))).toEqual(
      new Set(["Orchestrator", ...requiredChildren]),
    );
    expect(childStarts).toHaveLength(8);
    expect(childIds).toEqual(new Set(requiredChildren));
    expect(spawnedIds).toEqual(childIds);
    expect(childStarts.every((event) => event.attributes.parentAgentId === "Orchestrator")).toBe(
      true,
    );
    expect(childStarts.every((event) => event.parentSpanId !== undefined)).toBe(true);
    expect(joinedIds).toEqual(endedIds);
    expect(childEnds.every((event) => event.attributes.joinedBy === "Orchestrator")).toBe(true);
  });

  it("is a versioned, complete and private canonical recording", () => {
    expect(events).toHaveLength(691);
    expect(new Set(events.map((event) => event.traceId))).toEqual(
      new Set(["c068ecd2-a3ab-58a3-9825-225c584cc83a"]),
    );
    expect(new Set(events.map((event) => event.source.sourceEventId)).size).toBe(events.length);
    expect(events.every((event) => event.source.sourceInstanceId.endsWith("-topology-v2"))).toBe(
      true,
    );
    expect(events.every((event) => event.artifactRefs.length === 0)).toBe(true);
    expect(events.at(-1)?.kind).toBe("trace_complete");

    const blob = lines.join("\n");
    expect(blob).not.toMatch(/(?:\/home\/|\/Users\/|[A-Z]:\\)/u);
    expect(blob).not.toMatch(
      /"(?:thinking|thinkingSignature|signature|reasoning|systemPrompt)"\s*:/u,
    );
  });
});
