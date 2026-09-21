import { gzipSync } from "node:zlib";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CanonicalJsonlAdapter,
  ClaudeSessionAdapter,
  CodexSessionAdapter,
  detectSourceKind,
  computeSessionCandidateId,
  discoverSessionCandidates,
  OpenCodeSessionAdapter,
  OmpSessionAdapter,
  GrokSessionAdapter,
  OtlpHttpJsonAdapter,
  MalformedAdapterInputError,
  prepareSessionParts,
  sessionBundleContentSha256,
  UnsupportedAdapterVersionError,
  type AdapterRecord,
  type TraceAdapter,
} from "../src/index.js";

const fixtureRoot = resolve(import.meta.dirname, "../../test-fixtures/fixtures");

async function fixture(source: string, name: string): Promise<Uint8Array> {
  return readFile(resolve(fixtureRoot, source, name));
}

async function parse(adapter: TraceAdapter, bytes: Uint8Array): Promise<AdapterRecord[]> {
  const records: AdapterRecord[] = [];
  for await (const record of adapter.parse({
    parts: [{ path: ".", bytes }],
    sourceIdentity: "anonymous-fixture",
  })) {
    records.push(record);
  }
  return records;
}

describe("implemented trace adapters", () => {
  it("parses canonical JSONL and preserves duplicate source identities", async () => {
    const adapter = new CanonicalJsonlAdapter();
    const records = await parse(adapter, await fixture("jsonl", "duplicate.jsonl"));
    const events = records.filter((record) => record.type === "event");
    expect(events).toHaveLength(2);
    expect(events[0]?.event.source.sourceEventId).toBe(events[1]?.event.source.sourceEventId);
  });

  it("parses OTLP HTTP JSON and gzip", async () => {
    const adapter = new OtlpHttpJsonAdapter();
    const bytes = await fixture("otlp", "valid.json");
    expect((await parse(adapter, bytes)).filter((record) => record.type === "event")).toHaveLength(
      1,
    );
    expect(
      (await parse(adapter, gzipSync(bytes))).filter((record) => record.type === "event"),
    ).toHaveLength(1);
  });

  it("parses Codex session records and reports unknown records", async () => {
    const adapter = new CodexSessionAdapter();
    const records = await parse(adapter, await fixture("codex", "valid.jsonl"));
    expect(records.filter((record) => record.type === "event")).toHaveLength(3);
    const unknown = await parse(adapter, await fixture("codex", "unknown-record.jsonl"));
    expect(unknown.some((record) => record.type === "warning")).toBe(true);
  });
  it("maps Codex bundle lanes, parent spans, joins, fork dedup, and paginated downgrade", async () => {
    const records: AdapterRecord[] = [];
    for await (const record of new CodexSessionAdapter().parse({
      parts: [
        { path: "parent.jsonl", bytes: await fixture("codex", "topology/parent.jsonl") },
        { path: "child.jsonl", bytes: await fixture("codex", "topology/child.jsonl") },
        { path: "fork.jsonl", bytes: await fixture("codex", "topology/fork.jsonl") },
        { path: "paginated.jsonl", bytes: await fixture("codex", "topology/paginated.jsonl") },
      ],
      sourceIdentity: "anonymous-fixture",
    }))
      records.push(record);
    const events = records.filter((record) => record.type === "event");
    expect(new Set(events.map((record) => record.event.traceId))).toHaveLength(1);
    expect(new Set(events.map((record) => record.event.agentId))).toEqual(
      new Set(["codex-root", "codex-child", "codex-fork", "codex-paginated"]),
    );
    const childStart = events.find(
      (record) =>
        record.event.agentId === "codex-child" &&
        record.event.attributes.parentAgentId === "codex-root",
    );
    expect(childStart?.event.kind).toBe("agent_start");
    expect(childStart?.event.parentSpanId).toBe("call-spawn-1");
    expect(childStart?.event.attributes.topologyProvenance).toBe("stated");
    const paginatedStart = events.find(
      (record) => record.event.agentId === "codex-paginated" && record.event.kind === "agent_start",
    );
    expect(paginatedStart?.event.attributes.parentAgentId).toBe("codex-root");
    expect(paginatedStart?.event.attributes.topologyProvenance).toBe("inferred");
    expect(paginatedStart?.event.parentSpanId).toBeUndefined();
    expect(
      events.filter((record) => record.event.source.sourceEventId === "spawn-item"),
    ).toHaveLength(1);
    expect(events.some((record) => record.event.attributes.joinedBy === "codex-child")).toBe(true);
    expect(
      events.filter((record) => record.event.attributes.senderAgentId === "codex-child"),
    ).toHaveLength(1);
    const serialized = records
      .map((record) =>
        record.type === "artifact"
          ? new TextDecoder().decode(record.bytes)
          : JSON.stringify(record),
      )
      .join("\n");
    expect(serialized).not.toMatch(/gAAAA/u);
    expect(serialized).not.toMatch(/\/home\//u);
  });

  it("omits Codex reasoning, encrypted blocks, and world state from events and artifacts", async () => {
    const records = await parse(new CodexSessionAdapter(), await fixture("codex", "privacy.jsonl"));
    const events = records.filter((record) => record.type === "event");
    expect(events).toHaveLength(4);
    expect(events.some((record) => record.event.kind === "tool_result")).toBe(true);
    expect(events.some((record) => record.event.name.includes("Visible answer"))).toBe(true);
    expect(events.some((record) => record.event.name.includes("visible.txt"))).toBe(true);
    expect(events.some((record) => record.event.name.includes("Tool result: read_file"))).toBe(
      true,
    );
    expect(new Set(events.map((record) => record.event.traceId))).toHaveLength(1);
    expect(events[0]?.event.source.adapterVersion).toBe("3.0.0");
    expect(
      records.filter(
        (record) => record.type === "warning" && record.code === "sensitive_reasoning_omitted",
      ),
    ).toHaveLength(1);
    const serialized = records
      .map((record) =>
        record.type === "artifact"
          ? new TextDecoder().decode(record.bytes)
          : JSON.stringify(record),
      )
      .join("\n");
    expect(serialized).toContain("Visible answer");
    expect(serialized).not.toContain("must-not-persist");
  });

  it("parses Claude records including visible errors", async () => {
    const adapter = new ClaudeSessionAdapter();
    const records = await parse(adapter, await fixture("claude", "error.jsonl"));
    const event = records.find((record) => record.type === "event");
    expect(event?.type === "event" ? event.event.status : null).toBe("error");
  });
  it("maps Claude sidecar spawn endpoints, joins, paired peers, and workflow lanes", async () => {
    const parts = [
      { path: "root.jsonl", bytes: await fixture("claude", "topology/root.jsonl") },
      {
        path: "async-duplicate.jsonl",
        bytes: await fixture("claude", "topology/async-duplicate.jsonl"),
      },
      {
        path: "subagents/agent-child.jsonl",
        bytes: await fixture("claude", "topology/subagents/agent-child.jsonl"),
      },
      {
        path: "subagents/agent-child.meta.json",
        bytes: await fixture("claude", "topology/subagents/agent-child.meta.json"),
      },
      {
        path: "subagents/agent-workflow-agent.jsonl",
        bytes: await fixture("claude", "topology/subagents/agent-workflow-agent.jsonl"),
      },
      {
        path: "subagents/agent-workflow-agent.meta.json",
        bytes: await fixture("claude", "topology/subagents/agent-workflow-agent.meta.json"),
      },
    ];
    const records: AdapterRecord[] = [];
    for await (const record of new ClaudeSessionAdapter().parse({
      parts,
      sourceIdentity: "anonymous-fixture",
    }))
      records.push(record);
    const events = records.filter((record) => record.type === "event");
    expect(new Set(events.map((record) => record.event.agentId))).toEqual(
      new Set(["claude-root", "child-agent", "workflow-agent"]),
    );
    const childStart = events.find(
      (record) => record.event.kind === "agent_start" && record.event.agentId === "child-agent",
    );
    expect(childStart?.event.source.sourceEventId).toBe("agent-start-child-agent");
    expect(childStart?.event.attributes.parentAgentId).toBe("claude-root");
    expect(childStart?.event.parentSpanId).toBe("toolu-child-1");
    expect(childStart?.event.attributes.topologyProvenance).toBe("stated");
    expect(
      events.some(
        (record) =>
          record.event.agentId === "workflow-agent" &&
          record.event.attributes.parentAgentId !== undefined,
      ),
    ).toBe(false);
    const dispatch = events.find((record) => record.event.source.sourceEventId === "root-tool");
    expect(dispatch?.event.spanId).toBe("toolu-child-1");
    expect(
      events.filter((record) => record.event.attributes.joinedBy === "child-agent"),
    ).toHaveLength(2);
    expect(
      records.filter(
        (record) => record.type === "warning" && record.code === "duplicate_async_join_omitted",
      ),
    ).toHaveLength(1);
    const peers = events.filter((record) => record.event.attributes.senderAgentId !== undefined);
    expect(peers).toHaveLength(1);
    expect(peers[0]?.event.attributes).toMatchObject({
      senderAgentId: "claude-root",
      recipientAgentId: "child-agent",
      topologyProvenance: "inferred",
    });
    const serialized = records
      .map((record) =>
        record.type === "artifact"
          ? new TextDecoder().decode(record.bytes)
          : JSON.stringify(record),
      )
      .join("\n");
    expect(serialized).not.toContain("must-not-persist");
  });

  it("accepts Claude client versions while omitting thinking and file snapshots", async () => {
    const adapter = new ClaudeSessionAdapter();
    const bytes = await fixture("claude", "privacy.jsonl");
    await expect(
      adapter.sniff({ parts: [{ path: ".", bytes }], sourceIdentity: "anonymous-fixture" }),
    ).resolves.toBe(true);
    const records = await parse(adapter, bytes);
    expect(records.filter((record) => record.type === "event")).toHaveLength(3);
    const events = records.filter((record) => record.type === "event");
    expect(events.some((record) => record.event.name.includes("Visible request"))).toBe(true);
    expect(events.some((record) => record.event.name.includes("Visible answer"))).toBe(true);
    expect(events[0]?.event.source.adapterVersion).toBe("3.0.0");
    expect(
      records.filter(
        (record) => record.type === "warning" && record.code === "sensitive_reasoning_omitted",
      ),
    ).toHaveLength(1);
    const serialized = records
      .map((record) =>
        record.type === "artifact"
          ? new TextDecoder().decode(record.bytes)
          : JSON.stringify(record),
      )
      .join("\n");
    expect(serialized).toContain("Visible answer");
    expect(serialized).not.toContain("must-not-persist");
  });

  it("maps OpenCode SQLite topology, both join envelopes, and recovered overflow", async () => {
    const parts = [
      { path: "opencode.db", bytes: await fixture("opencode", "topology/opencode.db") },
      { path: "opencode.db-wal", bytes: await fixture("opencode", "topology/opencode.db-wal") },
      {
        path: "tool-output/tool-truncated",
        bytes: await fixture("opencode", "topology/tool-truncated"),
      },
    ];
    const records: AdapterRecord[] = [];
    for await (const record of new OpenCodeSessionAdapter().parse({
      parts,
      sourceIdentity: "anonymous-fixture",
    }))
      records.push(record);
    const events = records.filter((record) => record.type === "event");
    expect(new Set(events.map((record) => record.event.agentId))).toEqual(
      new Set(["ses-root", "ses-child", "ses-legacy"]),
    );
    expect(
      events.some(
        (record) =>
          record.event.attributes.parentAgentId === "ses-root" &&
          record.event.parentSpanId === "call-task-1",
      ),
    ).toBe(true);
    expect(
      events.some((record) => {
        const joined = record.event.attributes.joinedAgentIds;
        return Array.isArray(joined) && joined.includes("ses-child");
      }),
    ).toBe(true);
    expect(
      events.some((record) => {
        const joined = record.event.attributes.joinedAgentIds;
        return Array.isArray(joined) && joined.includes("ses-legacy");
      }),
    ).toBe(true);
    const recovered = events.find((record) => record.event.attributes.overflowRecovered === true);
    expect(recovered?.event.attributes.recoveredResultPreview).toContain(
      "recovered overflow answer",
    );
    expect(
      records.some(
        (record) => record.type === "warning" && record.code === "truncated_output_overflow_used",
      ),
    ).toBe(true);
    const serialized = records
      .map((record) =>
        record.type === "artifact"
          ? new TextDecoder().decode(record.bytes)
          : JSON.stringify(record),
      )
      .join("\n");
    expect(serialized).not.toContain("must-not-persist");
    expect(serialized).not.toMatch(/\/home\//u);
  });
  it("rejects ambiguous duplicate-basename OpenCode overflow references", async () => {
    const records: AdapterRecord[] = [];
    for await (const record of new OpenCodeSessionAdapter().parse({
      parts: [
        { path: "opencode.db", bytes: await fixture("opencode", "topology/opencode.db") },
        { path: "opencode.db-wal", bytes: await fixture("opencode", "topology/opencode.db-wal") },
        {
          path: "tool-output/tool-truncated",
          bytes: await fixture("opencode", "topology/tool-truncated"),
        },
        {
          path: "tool-output/alternate/tool-truncated",
          bytes: new TextEncoder().encode("ambiguous"),
        },
      ],
      sourceIdentity: "anonymous-fixture",
    }))
      records.push(record);
    expect(
      records.some(
        (record) =>
          record.type === "warning" && record.code === "truncated_output_overflow_ambiguous",
      ),
    ).toBe(true);
    expect(
      records.some(
        (record) => record.type === "event" && record.event.attributes.overflowRecovered === true,
      ),
    ).toBe(false);
  });
  it("drops embedded Codex ciphertext and vendor username values", async () => {
    const bytes = new TextEncoder().encode(
      `${JSON.stringify({ type: "session_meta", version: "codex-jsonl-v1", payload: { id: "privacy-codex" } })}\n${JSON.stringify({ type: "response_item", version: "codex-jsonl-v1", payload: { type: "function_call", name: "spawn_agent", call_id: "call-privacy", arguments: JSON.stringify({ message: "prefix gAAAAAembedded-token" }), username: "private-user" } })}\n`,
    );
    const records: AdapterRecord[] = [];
    for await (const record of new CodexSessionAdapter().parse({
      parts: [{ path: "privacy.jsonl", bytes }],
      sourceIdentity: "anonymous-fixture",
    }))
      records.push(record);
    const serialized = records
      .map((record) =>
        record.type === "artifact"
          ? new TextDecoder().decode(record.bytes)
          : JSON.stringify(record),
      )
      .join("\n");
    expect(serialized).not.toContain("gAAAAAembedded-token");
    expect(serialized).not.toContain("private-user");
  });
  it.each([
    [new CanonicalJsonlAdapter(), "jsonl", "unsupported.jsonl"],
    [new OtlpHttpJsonAdapter(), "otlp", "unsupported.json"],
    [new CodexSessionAdapter(), "codex", "unsupported.jsonl"],
    [new ClaudeSessionAdapter(), "claude", "unsupported.jsonl"],
  ] as const)("fails visibly for unsupported %s versions", async (adapter, source, name) => {
    await expect(parse(adapter, await fixture(source, name))).rejects.toBeInstanceOf(
      UnsupportedAdapterVersionError,
    );
  });
  it("does not create SQLite sidecars in the committed fixture directory", async () => {
    const fixtureDirectory = resolve(fixtureRoot, "opencode/topology");
    const before = (await readdir(fixtureDirectory)).sort();
    const records: AdapterRecord[] = [];
    for await (const record of new OpenCodeSessionAdapter().parse({
      parts: [
        { path: "opencode.db", bytes: await fixture("opencode", "topology/opencode.db") },
        { path: "opencode.db-wal", bytes: await fixture("opencode", "topology/opencode.db-wal") },
        {
          path: "tool-output/tool-truncated",
          bytes: await fixture("opencode", "topology/tool-truncated"),
        },
      ],
      sourceIdentity: "anonymous-fixture",
    }))
      records.push(record);
    expect(records.some((record) => record.type === "event")).toBe(true);
    expect((await readdir(fixtureDirectory)).sort()).toEqual(before);
  });
  it("maps OMP lanes, excludes synthetic spawns, and keeps parent spans empty", async () => {
    const parts = [
      { path: "root.jsonl", bytes: await fixture("omp", "topology/root.jsonl") },
      { path: "root/Child.jsonl", bytes: await fixture("omp", "topology/Child.jsonl") },
      { path: "root/Sibling.jsonl", bytes: await fixture("omp", "topology/Sibling.jsonl") },
      { path: "root/Synthetic.jsonl", bytes: await fixture("omp", "topology/Synthetic.jsonl") },
    ];
    const records: AdapterRecord[] = [];
    for await (const record of new OmpSessionAdapter().parse({
      parts,
      sourceIdentity: "anonymous-fixture",
    }))
      records.push(record);
    const events = records.filter((record) => record.type === "event");
    expect(new Set(events.map((record) => record.event.agentId))).toEqual(
      new Set(["Main", "Child", "Sibling", "Synthetic"]),
    );
    const spawned = events.filter((record) => record.event.attributes.parentAgentId === "Main");
    expect(new Set(spawned.map((record) => record.event.agentId))).toEqual(
      new Set(["Child", "Sibling"]),
    );
    expect(
      spawned.every((record) => record.event.attributes.topologyProvenance === "inferred"),
    ).toBe(true);
    expect(spawned.every((record) => record.event.parentSpanId === undefined)).toBe(true);
    expect(
      events.some(
        (record) =>
          record.event.agentId === "Synthetic" &&
          record.event.attributes.parentAgentId !== undefined,
      ),
    ).toBe(false);
    expect(
      events.some(
        (record) =>
          record.event.agentId === "Main" &&
          record.event.kind === "tool_result" &&
          Array.isArray(record.event.attributes.joinedAgentIds) &&
          (record.event.attributes.joinedAgentIds as string[]).includes("Child"),
      ),
    ).toBe(true);
    expect(
      events.some(
        (record) =>
          record.event.agentId === "Child" &&
          record.event.kind === "agent_end" &&
          record.event.attributes.joinedBy === "Main",
      ),
    ).toBe(true);
    expect(
      events.some(
        (record) =>
          record.event.attributes.senderAgentId === "Sibling" &&
          record.event.attributes.recipientAgentId === "Child",
      ),
    ).toBe(true);
    const peerFacts = events.filter(
      (record) => record.event.attributes.senderAgentId !== undefined,
    );
    expect(peerFacts).toHaveLength(1);
    expect(peerFacts[0]?.event.source.sourceEventId).toBe("peer");
    expect(peerFacts[0]?.event.attributes).toMatchObject({
      senderAgentId: "Sibling",
      recipientAgentId: "Child",
      messageId: "msg-1",
    });
    // Peer fidelity comes from the manifest; the fact must not stamp an upgrade.
    expect(peerFacts[0]?.event.attributes.topologyProvenance).toBeUndefined();
    const participatingLaneEvents = events.filter(
      (record) => record.event.agentId === "Sibling" || record.event.agentId === "Child",
    );
    expect(participatingLaneEvents).not.toHaveLength(0);
    expect(
      participatingLaneEvents.every(
        (record) =>
          record.event.attributes.senderAgentId === undefined &&
          record.event.attributes.recipientAgentId === undefined &&
          record.event.attributes.messageId === undefined,
      ),
    ).toBe(true);
    const serialized = records
      .map((record) =>
        record.type === "artifact"
          ? new TextDecoder().decode(record.bytes)
          : JSON.stringify(record),
      )
      .join("\n");
    expect(serialized).not.toContain("must-not-persist");
    expect(serialized).not.toMatch(/\/home\//u);
  });

  it("accepts a top-level JSON array as the same session as its JSONL form", async () => {
    const adapter = new ClaudeSessionAdapter();
    const lines = await parse(adapter, await fixture("claude", "valid.jsonl"));
    const array = await parse(adapter, await fixture("claude", "valid-array.json"));
    const lineEvents = lines.filter((record) => record.type === "event");
    const arrayEvents = array.filter((record) => record.type === "event");
    expect(arrayEvents).toHaveLength(lineEvents.length);
    expect(arrayEvents[0]?.event.traceId).toBe(lineEvents[0]?.event.traceId);
  });
  it("maps Grok real session ids, resumed chains, joins, and ignores spawn tool calls", async () => {
    const parts = [
      {
        path: "parent/updates.jsonl",
        bytes: await fixture("grok", "topology/parent/updates.jsonl"),
      },
      {
        path: "parent/subagents/child/meta.json",
        bytes: await fixture("grok", "topology/parent/subagents/child/meta.json"),
      },
      {
        path: "parent/subagents/child/output.json",
        bytes: await fixture("grok", "topology/parent/subagents/child/output.json"),
      },
      {
        path: "parent/subagents/only/meta.json",
        bytes: await fixture("grok", "topology/only/meta.json"),
      },
      {
        path: "parent/subagents/only/output.json",
        bytes: await fixture("grok", "topology/only/output.json"),
      },
      { path: "child/updates.jsonl", bytes: await fixture("grok", "topology/child/updates.jsonl") },
      { path: "only/updates.jsonl", bytes: await fixture("grok", "topology/only/updates.jsonl") },
      {
        path: "resume/updates.jsonl",
        bytes: await fixture("grok", "topology/resume/updates.jsonl"),
      },
      { path: "parent/updates.jsonl.lock", bytes: new Uint8Array() },
    ];
    const records: AdapterRecord[] = [];
    for await (const record of new GrokSessionAdapter().parse({
      parts,
      sourceIdentity: "anonymous-fixture",
    }))
      records.push(record);
    const events = records.filter((record) => record.type === "event");
    expect(new Set(events.map((record) => record.event.agentId))).toEqual(
      new Set(["grok-root", "grok-child", "grok-only"]),
    );
    const childStart = events.find(
      (record) => record.event.source.sourceEventId === "agent-start-grok-child",
    );
    expect(childStart?.event.attributes.parentAgentId).toBe("grok-root");
    expect(childStart?.event.parentSpanId).toBe("prompt-child-1");
    const onlyStart = events.find(
      (record) => record.event.source.sourceEventId === "agent-start-grok-only",
    );
    expect(onlyStart?.event.attributes.parentAgentId).toBe("grok-root");
    expect(onlyStart?.event.parentSpanId).toBeUndefined();
    expect(
      events.some((record) => record.event.source.sourceEventId === "agent-start-grok-resume"),
    ).toBe(false);
    expect(
      events.some(
        (record) =>
          record.event.source.sourceEventId === "join-grok-only" &&
          record.event.kind === "tool_result" &&
          record.event.agentId === "grok-root",
      ),
    ).toBe(true);
    expect(
      events.some(
        (record) =>
          record.event.source.sourceEventId === "agent-end-grok-only" &&
          record.event.kind === "agent_end" &&
          record.event.attributes.joinedBy === "grok-root",
      ),
    ).toBe(true);
    expect(
      events.some(
        (record) =>
          record.event.attributes.recordType === "tool_call" &&
          record.event.attributes.spawnedAgentIds !== undefined,
      ),
    ).toBe(false);
    expect(
      records.some(
        (record) => record.type === "warning" && record.code === "sensitive_reasoning_omitted",
      ),
    ).toBe(true);
    const serialized = records
      .map((record) =>
        record.type === "artifact"
          ? new TextDecoder().decode(record.bytes)
          : JSON.stringify(record),
      )
      .join("\n");
    expect(serialized).not.toContain("must-not-persist");
    expect(serialized).not.toMatch(/\/home\//u);
  });

  it.each([
    ["codex", "codex-child"],
    ["claude", "child-agent"],
    ["opencode", "ses-child"],
    ["omp", "Child"],
    ["grok", "grok-child"],
  ] as const)("emits reducer-derivable spawn and join facts for %s", async (source, childLane) => {
    const bundles: Record<
      string,
      () => Promise<{ adapter: TraceAdapter; parts: { path: string; bytes: Uint8Array }[] }>
    > = {
      codex: async () => ({
        adapter: new CodexSessionAdapter(),
        parts: [
          { path: "parent.jsonl", bytes: await fixture("codex", "topology/parent.jsonl") },
          { path: "child.jsonl", bytes: await fixture("codex", "topology/child.jsonl") },
        ],
      }),
      claude: async () => ({
        adapter: new ClaudeSessionAdapter(),
        parts: [
          { path: "root.jsonl", bytes: await fixture("claude", "topology/root.jsonl") },
          {
            path: "subagents/agent-child.jsonl",
            bytes: await fixture("claude", "topology/subagents/agent-child.jsonl"),
          },
          {
            path: "subagents/agent-child.meta.json",
            bytes: await fixture("claude", "topology/subagents/agent-child.meta.json"),
          },
        ],
      }),
      opencode: async () => ({
        adapter: new OpenCodeSessionAdapter(),
        parts: [
          { path: "opencode.db", bytes: await fixture("opencode", "topology/opencode.db") },
          { path: "opencode.db-wal", bytes: await fixture("opencode", "topology/opencode.db-wal") },
          {
            path: "tool-output/tool-truncated",
            bytes: await fixture("opencode", "topology/tool-truncated"),
          },
        ],
      }),
      omp: async () => ({
        adapter: new OmpSessionAdapter(),
        parts: [
          { path: "root.jsonl", bytes: await fixture("omp", "topology/root.jsonl") },
          { path: "root/Child.jsonl", bytes: await fixture("omp", "topology/Child.jsonl") },
          { path: "root/Sibling.jsonl", bytes: await fixture("omp", "topology/Sibling.jsonl") },
        ],
      }),
      grok: async () => ({
        adapter: new GrokSessionAdapter(),
        parts: [
          {
            path: "parent/updates.jsonl",
            bytes: await fixture("grok", "topology/parent/updates.jsonl"),
          },
          {
            path: "parent/subagents/child/meta.json",
            bytes: await fixture("grok", "topology/parent/subagents/child/meta.json"),
          },
          {
            path: "parent/subagents/child/output.json",
            bytes: await fixture("grok", "topology/parent/subagents/child/output.json"),
          },
          {
            path: "child/updates.jsonl",
            bytes: await fixture("grok", "topology/child/updates.jsonl"),
          },
        ],
      }),
    };
    const { adapter, parts } = await bundles[source]!();
    const records: AdapterRecord[] = [];
    for await (const record of adapter.parse({ parts, sourceIdentity: "anonymous-fixture" }))
      records.push(record);
    const events = records
      .filter((record) => record.type === "event")
      .map((record) => record.event);

    const childStart = events.find(
      (event) =>
        event.kind === "agent_start" &&
        event.agentId === childLane &&
        typeof event.attributes.parentAgentId === "string",
    );
    expect(childStart, "child agent_start with parentAgentId").toBeDefined();
    const parentLane = String(childStart!.attributes.parentAgentId);
    const spawnPartner = events.find(
      (event) =>
        event.agentId === parentLane &&
        ((childStart!.parentSpanId !== undefined && event.spanId === childStart!.parentSpanId) ||
          (Array.isArray(event.attributes.spawnedAgentIds) &&
            (event.attributes.spawnedAgentIds as string[]).includes(childLane))),
    );
    expect(
      spawnPartner,
      "parent fact matching child parentSpanId or spawnedAgentIds",
    ).toBeDefined();

    const joinResult = events.find(
      (event) =>
        event.kind === "tool_result" &&
        Array.isArray(event.attributes.joinedAgentIds) &&
        (event.attributes.joinedAgentIds as string[]).includes(childLane),
    );
    expect(joinResult, "parent tool_result carrying joinedAgentIds").toBeDefined();
    const childEnd = events.find(
      (event) => event.kind === "agent_end" && event.agentId === childLane,
    );
    expect(childEnd, "child agent_end").toBeDefined();
  });

  it("accepts a single pretty-printed JSON object as one record", async () => {
    const records = await parse(
      new CodexSessionAdapter(),
      await fixture("codex", "valid-single.json"),
    );
    expect(records.filter((record) => record.type === "event")).toHaveLength(1);
  });

  it("still reports the original line diagnostic for non-JSON input", async () => {
    const bytes = new TextEncoder().encode('{"type":"user"}\nnot json\n');
    await expect(parse(new ClaudeSessionAdapter(), bytes)).rejects.toBeInstanceOf(
      MalformedAdapterInputError,
    );
  });

  it.each([
    ["jsonl", "valid.jsonl", "jsonl"],
    ["otlp", "valid.json", "otlp"],
    ["codex", "valid.jsonl", "codex"],
    ["claude", "valid.jsonl", "claude"],
  ] as const)("detects %s fixtures", async (directory, name, expected) => {
    const bytes = await fixture(directory, name);
    await expect(
      detectSourceKind({ parts: [{ path: ".", bytes }], sourceIdentity: "fixture" }),
    ).resolves.toBe(expected);
  });

  it("returns null when no adapter recognizes the bytes", async () => {
    await expect(
      detectSourceKind({
        parts: [{ path: ".", bytes: Buffer.from("not json") }],
        sourceIdentity: "fixture",
      }),
    ).resolves.toBeNull();
  });
});

describe("session bundle preparation", () => {
  const canonical = (traceId: string, sourceEventId: string) =>
    Buffer.from(
      `${JSON.stringify({
        schemaVersion: "1.0.0",
        workspaceId: "11111111-1111-4111-8111-111111111111",
        projectId: "22222222-2222-4222-8222-222222222222",
        traceId,
        workspaceName: "Fixture",
        projectName: "Bundle",
        traceTitle: `Trace ${traceId.slice(0, 4)}`,
        source: {
          kind: "jsonl",
          formatVersion: "1.0.0",
          adapterVersion: "1.0.0",
          sourceInstanceId: "bundle-fixture",
          sourceEventId,
        },
        occurredAt: "2026-08-01T00:00:00.000Z",
        kind: "user_message",
        name: "Request",
        status: "ok",
        artifactRefs: [],
        attributes: {},
      })}\n`,
    );

  it("hashes normalized POSIX-sorted parts with the session domain", () => {
    const hash = sessionBundleContentSha256([
      { path: "z.jsonl", bytes: new Uint8Array([2]) },
      { path: "a/./b.jsonl", bytes: new Uint8Array([1]) },
    ]);
    expect(hash).toBe(
      sessionBundleContentSha256([
        { path: "a/b.jsonl", bytes: new Uint8Array([1]) },
        { path: "z.jsonl", bytes: new Uint8Array([2]) },
      ]),
    );
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      sessionBundleContentSha256([{ path: "a/b.jsonl", bytes: new Uint8Array([2]) }]),
    ).not.toBe(hash);
  });

  it("returns one prepared bundle per logical trace", async () => {
    const prepared = await prepareSessionParts(
      "jsonl",
      [
        { path: "b.jsonl", bytes: canonical("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "b") },
        { path: "a.jsonl", bytes: canonical("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "a") },
      ],
      "bundle-fixture",
      {
        id: "a".repeat(24),
        byteLength: 2,
        modifiedAt: "2026-08-01T00:00:00.000Z",
      },
    );
    expect(prepared).toHaveLength(2);
    expect(prepared.map((bundle) => bundle.events[0]?.event.traceId)).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]);
    expect(prepared.every((bundle) => bundle.artifacts.length === 0)).toBe(true);
    expect(prepared.every((bundle) => bundle.completionMarker.kind === "trace_complete")).toBe(
      true,
    );
    expect(new Set(prepared.map((bundle) => bundle.contentSha256)).size).toBe(2);
  });

  it("keeps referenced artifact keys unresolved and only retains referenced bytes", async () => {
    class ArtifactAdapter extends CanonicalJsonlAdapter {
      override async *parse(): AsyncIterable<AdapterRecord> {
        const event = JSON.parse(
          canonical("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "a").toString(),
        ) as never;
        yield { type: "event", event, artifactKeys: ["used"] };
        yield {
          type: "artifact",
          key: "unused",
          sourceEventId: "a",
          bytes: Buffer.from("unused"),
          mediaType: "text/plain",
        };
        yield {
          type: "artifact",
          key: "used",
          sourceEventId: "a",
          bytes: Buffer.from("used"),
          mediaType: "text/plain",
        };
      }
    }
    const prepared = await prepareSessionParts(
      "jsonl",
      [{ path: ".", bytes: canonical("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "a") }],
      "bundle-fixture",
      { id: "a".repeat(24), byteLength: 1, modifiedAt: "2026-08-01T00:00:00.000Z" },
      new ArtifactAdapter(),
    );
    expect(prepared[0]?.events[0]?.artifactKeys).toEqual(["used"]);
    expect(prepared[0]?.artifacts.map((artifact) => artifact.key)).toEqual(["used"]);
  });

  it.each(["missing", "duplicate"] as const)(
    "rejects %s referenced artifact keys during preflight",
    async (mode) => {
      class BrokenArtifactAdapter extends CanonicalJsonlAdapter {
        override async *parse(): AsyncIterable<AdapterRecord> {
          const event = JSON.parse(
            canonical("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "a").toString(),
          ) as never;
          yield { type: "event", event, artifactKeys: ["required"] };
          if (mode === "duplicate") {
            for (let index = 0; index < 2; index += 1) {
              yield {
                type: "artifact",
                key: "required",
                sourceEventId: "a",
                bytes: Buffer.from("x"),
                mediaType: "text/plain",
              };
            }
          }
        }
      }
      await expect(
        prepareSessionParts(
          "jsonl",
          [{ path: ".", bytes: canonical("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "a") }],
          "bundle-fixture",
          { id: "a".repeat(24), byteLength: 1, modifiedAt: "2026-08-01T00:00:00.000Z" },
          new BrokenArtifactAdapter(),
        ),
      ).rejects.toThrow(
        mode === "missing" ? "Missing referenced artifact key" : "Duplicate artifact key",
      );
    },
  );
});

describe("session candidate discovery", () => {
  const part = (path: string, text: string, complete = true) => ({
    clientRef: path,
    path,
    byteLength: Buffer.byteLength(text),
    modifiedAt: "2026-08-01T00:00:00.000Z",
    bytes: Buffer.from(text),
    complete,
  });

  it("keeps JSONL and OTLP candidates to one part", async () => {
    const jsonl = await fixture("jsonl", "valid.jsonl");
    const candidates = await discoverSessionCandidates("jsonl", [
      { ...part("a.jsonl", ""), bytes: jsonl, byteLength: jsonl.byteLength },
      { ...part("b.jsonl", ""), bytes: jsonl, byteLength: jsonl.byteLength },
    ]);
    expect(candidates.map((candidate) => candidate.partRefs)).toEqual([["a.jsonl"], ["b.jsonl"]]);
  });

  it("groups Claude roots with matching subagents and metadata", async () => {
    const candidates = await discoverSessionCandidates("claude", [
      part(
        "root.jsonl",
        '{"type":"user","sessionId":"root","message":{"role":"user","content":"x"}}\n',
      ),
      part(
        "subagents/agent-child.jsonl",
        '{"type":"assistant","sessionId":"root","agentId":"child","message":{"role":"assistant","content":"x"}}\n',
      ),
      part("subagents/agent-child.meta.json", '{"sessionId":"root"}'),
    ]);
    expect(candidates[0]?.partRefs).toEqual([
      "root.jsonl",
      "subagents/agent-child.jsonl",
      "subagents/agent-child.meta.json",
    ]);
  });

  it("returns preflight_failed instead of guessing incomplete OpenCode heads", async () => {
    const candidates = await discoverSessionCandidates("opencode", [
      part("opencode.db", "SQLite format 3", false),
      part("opencode.db-wal", "wal", false),
    ]);
    expect(candidates).toEqual([
      expect.objectContaining({
        source: "opencode",
        failureCode: "preflight_failed",
        partRefs: ["opencode.db", "opencode.db-wal"],
      }),
    ]);
  });

  it("returns preflight_failed when an OMP companion directory is absent", async () => {
    const candidates = await discoverSessionCandidates("omp", [
      part("root.jsonl", '{"id":"root","details":{"progress":[{"id":"child"}]}}\n'),
    ]);
    expect(candidates[0]).toMatchObject({
      source: "omp",
      failureCode: "preflight_failed",
      partRefs: ["root.jsonl"],
    });
  });

  it("derives the same candidate ID for success and preflight failure", async () => {
    const paths = ["root.jsonl", "root/child.jsonl"];
    const expected = computeSessionCandidateId("omp", "root", paths);
    const success = await discoverSessionCandidates("omp", [
      part("root.jsonl", '{"id":"root"}\n'),
      part("root/child.jsonl", '{"id":"child"}\n'),
    ]);
    const failure = await discoverSessionCandidates("omp", [
      part("root.jsonl", '{"id":"root","details":{"progress":[{"id":"child"}]}}\n'),
    ]);
    expect(success[0]?.candidateId).toBe(expected);
    expect(failure[0]?.candidateId).toBe(computeSessionCandidateId("omp", "root", ["root.jsonl"]));
  });

  it("caps candidate roots before preparation while preserving companions", async () => {
    const candidates = await discoverSessionCandidates(
      "jsonl",
      Array.from({ length: 51 }, (_, index) => part(`root-${index}.jsonl`, "{}\n")),
      50,
    );
    expect(candidates).toHaveLength(50);
  });

  it("does not attach unrelated Claude sidecars to every root", async () => {
    const candidates = await discoverSessionCandidates("claude", [
      part("a.jsonl", '{"type":"user","sessionId":"a"}\n'),
      part("b.jsonl", '{"type":"user","sessionId":"b"}\n'),
      part("subagents/agent-a.meta.json", '{"sessionId":"a"}'),
      part("subagents/agent-b.meta.json", '{"sessionId":"b"}'),
    ]);
    expect(candidates.map((candidate) => candidate.partRefs)).toEqual([
      ["a.jsonl", "subagents/agent-a.meta.json"],
      ["b.jsonl", "subagents/agent-b.meta.json"],
    ]);
  });
});
