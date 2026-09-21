import { describe, expect, it } from "vitest";

import {
  adapterManifests,
  aggregateTopologyCapabilities,
  CanonicalJsonlAdapter,
  lookupTopologyCapability,
  normalizeAdapterInput,
  topologyAttributeKeys,
  type AdapterInput,
  type CanonicalTopologyAttributes,
} from "../src/index.js";

describe("adapter registry contract", () => {
  it("registers every locked MVP source as an implemented adapter", () => {
    expect(adapterManifests.map((manifest) => manifest.source)).toEqual([
      "jsonl",
      "otlp",
      "codex",
      "claude",
      "opencode",
      "omp",
      "grok",
    ]);
    expect(adapterManifests.every((manifest) => manifest.status === "implemented")).toBe(true);
  });
  it("publishes exact implemented and canonical-only topology declarations", () => {
    expect(adapterManifests.map(({ source, topology }) => ({ source, topology }))).toEqual([
      { source: "jsonl", topology: lookupTopologyCapability("jsonl", "1.0.0") },
      { source: "otlp", topology: lookupTopologyCapability("otlp", "1.0.0") },
      { source: "codex", topology: lookupTopologyCapability("codex", "3.0.0") },
      { source: "claude", topology: lookupTopologyCapability("claude", "3.0.0") },
      { source: "opencode", topology: lookupTopologyCapability("opencode", "1.0.0") },
      { source: "omp", topology: lookupTopologyCapability("omp", "1.0.0") },
      { source: "grok", topology: lookupTopologyCapability("grok", "1.0.0") },
    ]);
    expect(lookupTopologyCapability("pi", "anything")).toEqual({
      spawn: "unsupported",
      join: "unsupported",
      peerMessages: "unsupported",
      input: "single-file",
      laneKey: "session.id",
      limits: [
        "Default Pi has no structural subagent capability; bash launches and parentSession forks are not spawn facts.",
      ],
    });
  });

  it("returns conservative source-shaped fallbacks without throwing", () => {
    expect(lookupTopologyCapability("codex", "99.0.0")).toEqual({
      spawn: "unsupported",
      join: "unsupported",
      peerMessages: "unsupported",
      input: "bundle",
      laneKey: "session_meta.payload.id",
      limits: ["No topology declaration for codex@99.0.0"],
    });
    expect(lookupTopologyCapability("custom", "producer-v1")).toEqual({
      spawn: "unsupported",
      join: "unsupported",
      peerMessages: "unsupported",
      input: "single-file",
      laneKey: "custom",
      limits: ["No topology declaration for custom@producer-v1"],
    });
  });

  it("aggregates mixed declarations conservatively and deterministically", () => {
    expect(
      aggregateTopologyCapabilities([
        { sourceKind: "jsonl", adapterVersion: "1.0.0" },
        { sourceKind: "codex", adapterVersion: "3.0.0" },
      ]),
    ).toEqual({
      spawn: "inferred",
      join: "inferred",
      peerMessages: "inferred",
      input: "bundle",
      laneKey: "mixed",
      limits: [
        "codex@3.0.0: Collaboration message bodies are encrypted and unavailable.",
        "codex@3.0.0: Full-history forks duplicate ancestor records and require payload-hash deduplication.",
        "codex@3.0.0: Paginated history may omit persisted sub_agent_activity, so affected spawn facts are inferred or absent.",
        "jsonl@1.0.0: Topology requires explicit canonical fields; passthrough never infers a missing relationship.",
      ],
    });
  });

  it("locks the canonical topology attribute vocabulary", () => {
    expect(topologyAttributeKeys).toEqual([
      "parentAgentId",
      "spawnedAgentIds",
      "joinedAgentIds",
      "joinedBy",
      "senderAgentId",
      "recipientAgentId",
      "messageId",
      "onBehalfOf",
      "assignedBy",
      "topologyProvenance",
    ]);
    const attributes = {
      parentAgentId: "parent",
      spawnedAgentIds: ["child"],
      joinedAgentIds: ["child"],
      joinedBy: "parent",
      senderAgentId: "sender",
      recipientAgentId: "recipient",
      messageId: "message",
      onBehalfOf: "beneficiary",
      assignedBy: "assigner",
      topologyProvenance: "inferred",
    } satisfies CanonicalTopologyAttributes;
    expect(attributes.topologyProvenance).toBe("inferred");
  });

  it.each([
    ["empty parts", { parts: [], sourceIdentity: "fixture" }],
    [
      "duplicate normalized paths",
      {
        parts: [
          { path: "a/./b.jsonl", bytes: new Uint8Array() },
          { path: "a/b.jsonl", bytes: new Uint8Array() },
        ],
        sourceIdentity: "fixture",
      },
    ],
    [
      "absolute path",
      { parts: [{ path: "/a.jsonl", bytes: new Uint8Array() }], sourceIdentity: "fixture" },
    ],
    [
      "parent segment",
      { parts: [{ path: "a/../b.jsonl", bytes: new Uint8Array() }], sourceIdentity: "fixture" },
    ],
    [
      "NUL",
      { parts: [{ path: "a\0b.jsonl", bytes: new Uint8Array() }], sourceIdentity: "fixture" },
    ],
    [
      "backslash",
      { parts: [{ path: "a\\b.jsonl", bytes: new Uint8Array() }], sourceIdentity: "fixture" },
    ],
  ] as const)("rejects %s at the shared session boundary", (_name, input) => {
    expect(() => normalizeAdapterInput(input as AdapterInput)).toThrow();
  });

  it("sorts and normalizes accepted relative parts", () => {
    expect(
      normalizeAdapterInput({
        parts: [
          { path: "z.jsonl", bytes: new Uint8Array([2]) },
          { path: "a/./b.jsonl", bytes: new Uint8Array([1]) },
        ],
        sourceIdentity: "fixture",
      }).parts.map((part) => part.path),
    ).toEqual(["a/b.jsonl", "z.jsonl"]);
  });

  it("parsers reject invalid bundle paths before reading bytes", async () => {
    const adapter = new CanonicalJsonlAdapter();
    const input = {
      parts: [{ path: "../event.jsonl", bytes: new Uint8Array() }],
      sourceIdentity: "fixture",
    };
    await expect(adapter.sniff(input)).rejects.toThrow();
    await expect(async () => {
      for await (const record of adapter.parse(input)) {
        expect(record).toBeDefined();
      }
    }).rejects.toThrow();
  });
});
