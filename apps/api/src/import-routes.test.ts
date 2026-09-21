import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type { ApiServices } from "./services.js";

const fixtureRoot = resolve(import.meta.dirname, "../../../packages/test-fixtures/fixtures");

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function services(
  order: string[],
  duplicate = false,
  ingestWarnings: Array<{ code: string; sourceEventId?: string }> = [],
): ApiServices {
  let sequence = 0;
  return {
    repository: {
      ensureTrace: async () => {
        order.push("ensureTrace");
      },
      registerArtifact: async (input) => {
        order.push("registerArtifact");
        return { id: "44444444-4444-4444-8444-444444444444", redacted: false, ...input };
      },
      getArtifact: async () => {
        throw new Error("unused");
      },
      ingest: async (input) => {
        order.push("ingest");
        sequence += 1;
        const event = { ...input };
        delete event.workspaceName;
        delete event.projectName;
        delete event.traceTitle;
        delete event.payload;
        return {
          event: {
            ...event,
            id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
            ingestSeq: String(sequence),
            ingestedAt: "2026-08-03T00:00:01.000Z",
          },
          duplicate,
          traceStale: false,
          warnings: ingestWarnings,
        };
      },
      listTraces: async () => ({ traces: [], nextCursor: null }),
      listTracesByIds: async () => {
        order.push("listTracesByIds");
        return [];
      },
      getTrace: async () => {
        throw new Error("unused");
      },
      listRawEvents: async () => ({ events: [], nextCursor: null }),
      getAgentTimeline: async () => [],
      listStreamEvents: async () => [],
      getStreamBounds: async () => ({ earliest: null, latest: null }),
      listProviderCalls: async () => [],
      listRevisions: async () => [],
      getGraph: async () => null,
      getObservedTopology: async () => ({
        observed: { lanes: 0, lanesWithParent: 0, spawnEdges: 0, peerEdges: 0 },
        sources: [],
      }),
      editSemanticNode: async () => {
        throw new Error("unused");
      },
      deleteTraceData: async () => undefined,
    },
    artifactStore: {
      put: async (input) => ({
        traceId: input.traceId,
        sha256: "a".repeat(64),
        byteLength: input.bytes.byteLength,
        mediaType: input.mediaType,
      }),
      stat: async () => null,
      getRange: async () => new Uint8Array(),
      deleteTrace: async () => undefined,
    },
  };
}

async function codexFixture(): Promise<Buffer> {
  return readFile(resolve(fixtureRoot, "codex/valid.jsonl"));
}

async function claudeFixture(): Promise<Buffer> {
  return readFile(resolve(fixtureRoot, "claude/valid.jsonl"));
}

function frame(
  parts: Array<{ clientRef: string; path: string; bytes: Buffer }>,
  source: string,
  candidateIds: string[],
): Buffer {
  let offset = 0;
  const manifest = {
    protocolVersion: 1,
    source,
    candidateIds,
    parts: parts.map((part) => {
      const framed = {
        clientRef: part.clientRef,
        path: part.path,
        offset,
        byteLength: part.bytes.byteLength,
        modifiedAt: "2026-08-01T00:00:00.000Z",
      };
      offset += part.bytes.byteLength;
      return framed;
    }),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const header = Buffer.alloc(8);
  header.write("ITB1", 0, "ascii");
  header.writeUInt32BE(manifestBytes.byteLength, 4);
  return Buffer.concat([header, manifestBytes, ...parts.map((part) => part.bytes)]);
}

function rawFrame(manifest: Record<string, unknown>, payload: Buffer): Buffer {
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const header = Buffer.alloc(8);
  header.write("ITB1", 0, "ascii");
  header.writeUInt32BE(manifestBytes.byteLength, 4);
  return Buffer.concat([header, manifestBytes, payload]);
}

async function inspect(
  app: ReturnType<typeof buildApp>,
  bytes: Buffer,
  includePreviews: boolean,
  fileName = "valid.jsonl",
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/imports/candidates",
    payload: {
      protocolVersion: 2,
      includePreviews,
      parts: [
        {
          clientRef: "c1",
          path: fileName,
          byteLength: bytes.byteLength,
          modifiedAt: "2026-08-01T00:00:00.000Z",
          headBase64: bytes.toString("base64"),
          complete: true,
        },
      ],
    },
  });
}

describe("browser session import routes", () => {
  it("redacts previews from candidate inspection by default", async () => {
    const app = buildApp({ services: services([]) });
    apps.push(app);
    const response = await inspect(app, await codexFixture(), false);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.alreadyImportedCount).toBe(0);
    expect(body.candidates[0]).toMatchObject({
      clientRef: "c1",
      candidateId: expect.stringMatching(/^[a-f0-9]{24}$/u),
      partRefs: ["c1"],
      source: "codex",
      title: "Codex session",
      firstPromptPreview: null,
      lastPromptPreview: null,
      imported: false,
      failureCode: null,
    });
  });

  it("hides the derived title and prompt previews until previews are consented to", async () => {
    const app = buildApp({ services: services([]) });
    apps.push(app);
    const bytes = await claudeFixture();
    const hidden = (await inspect(app, bytes, false, "claude.jsonl")).json();
    expect(hidden.candidates[0]).toMatchObject({
      source: "claude",
      title: "Claude session",
      firstPromptPreview: null,
      lastPromptPreview: null,
    });

    const shown = (await inspect(app, bytes, true, "claude.jsonl")).json();
    expect(shown.candidates[0].title).toBe("Claude · Synthetic request");
    expect(shown.candidates[0].firstPromptPreview).toBe("Synthetic request");
  });

  it("imports an uploaded session and appends the completion marker", async () => {
    const order: string[] = [];
    const app = buildApp({ services: services(order) });
    apps.push(app);
    const bytes = await codexFixture();
    const inspection = await inspect(app, bytes, false);
    const selectedId = inspection.json().candidates[0].candidateId as string;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/imports/sessions",
      headers: { "content-type": "application/vnd.intenttrace.session-bundle" },
      payload: frame([{ clientRef: "c1", path: "valid.jsonl", bytes }], "auto", [selectedId]),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.command).toBe("upload");
    expect(body.protocolVersion).toBe(2);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].sessionId).toMatch(/^[a-f0-9]{24}$/u);
    expect(body.results[0].inserted).toBe(4);
    expect(body.results[0].duplicates).toBe(0);
    expect(order.filter((entry) => entry === "ingest")).toHaveLength(4);
  });

  it("adds repository ingest warnings to upload warning totals", async () => {
    const bytes = await codexFixture();
    const app = buildApp({
      services: services([], false, [
        { code: "causation_source_event_unresolved", sourceEventId: "parent" },
      ]),
    });
    apps.push(app);

    const inspected = await inspect(app, bytes, false);
    const selectedId = inspected.json().candidates[0].candidateId as string;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/imports/sessions",
      headers: { "content-type": "application/vnd.intenttrace.session-bundle" },
      payload: frame([{ clientRef: "c1", path: "valid.jsonl", bytes }], "codex", [selectedId]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results[0].warnings).toBe(4);
  });

  it("reports every event as a duplicate when the same bytes were already imported", async () => {
    const first = buildApp({ services: services([]) });
    const second = buildApp({ services: services([], true) });
    apps.push(first, second);
    const bytes = await codexFixture();
    const inspected = await inspect(first, bytes, false);
    const selectedId = inspected.json().candidates[0].candidateId as string;
    const url = "/api/v1/imports/sessions";
    const headers = { "content-type": "application/vnd.intenttrace.session-bundle" };
    const payload = frame([{ clientRef: "c1", path: "valid.jsonl", bytes }], "auto", [selectedId]);
    const original = (await first.inject({ method: "POST", url, headers, payload })).json()
      .results[0];
    const repeat = (await second.inject({ method: "POST", url, headers, payload })).json()
      .results[0];
    expect(repeat.inserted).toBe(0);
    expect(repeat.duplicates).toBe(4);
    expect(repeat.traceId).toBe(original.traceId);
    expect(repeat.sessionId).toBe(original.sessionId);
  });

  it("rejects unrecognizable bytes before ingesting anything", async () => {
    const order: string[] = [];
    const app = buildApp({ services: services(order) });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/imports/sessions",
      headers: { "content-type": "application/vnd.intenttrace.session-bundle" },
      payload: frame(
        [{ clientRef: "c1", path: "broken.jsonl", bytes: Buffer.from("{ not json") }],
        "auto",
        ["a".repeat(24)],
      ),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("unknown_source_format");
    expect(order).toEqual([]);
  });

  it("answers a body over the configured cap with 413 payload_too_large", async () => {
    const app = buildApp({ services: services([]), uploadMaxBytes: 65_536 });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/imports/sessions",
      headers: { "content-type": "application/vnd.intenttrace.session-bundle" },
      payload: Buffer.alloc(70_000, 0x61),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().code).toBe("payload_too_large");
  });

  it("rejects malformed frames and stale candidate IDs before inserting", async () => {
    const order: string[] = [];
    const app = buildApp({ services: services(order) });
    apps.push(app);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/v1/imports/candidates",
      headers: { "content-type": "application/vnd.intenttrace.session-bundle" },
      payload: Buffer.from("ITB1\0\0\0\x02{}"),
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().code).toBe("invalid_session_bundle");

    const bytes = await codexFixture();
    const stale = await app.inject({
      method: "POST",
      url: "/api/v1/imports/sessions",
      headers: { "content-type": "application/vnd.intenttrace.session-bundle" },
      payload: frame([{ clientRef: "c1", path: "valid.jsonl", bytes }], "codex", ["f".repeat(24)]),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("stale_session");
    expect(order.filter((entry) => entry === "ingest")).toEqual([]);
  });

  it("rejects gaps, overlaps, and non-covering payload ranges", async () => {
    const app = buildApp({ services: services([]) });
    apps.push(app);
    const bytes = await codexFixture();
    const valid = frame([{ clientRef: "c1", path: "valid.jsonl", bytes }], "codex", []);
    const manifestLength = valid.readUInt32BE(4);
    const manifest = JSON.parse(valid.subarray(8, 8 + manifestLength).toString()) as {
      parts: Array<{ offset: number }>;
    };
    manifest.parts[0]!.offset = 1;
    const changedManifest = Buffer.from(JSON.stringify(manifest));
    const header = Buffer.alloc(8);
    header.write("ITB1", 0, "ascii");
    header.writeUInt32BE(changedManifest.byteLength, 4);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/imports/candidates",
      headers: { "content-type": "application/vnd.intenttrace.session-bundle" },
      payload: Buffer.concat([header, changedManifest, bytes]),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("invalid_session_bundle");
  });

  it.each([
    [
      "duplicate clientRef",
      [
        {
          clientRef: "same",
          path: "a.jsonl",
          offset: 0,
          byteLength: 1,
          modifiedAt: "2026-08-01T00:00:00.000Z",
        },
        {
          clientRef: "same",
          path: "b.jsonl",
          offset: 1,
          byteLength: 1,
          modifiedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      Buffer.from("ab"),
    ],
    [
      "manifest order differs from offsets",
      [
        {
          clientRef: "b",
          path: "b.jsonl",
          offset: 1,
          byteLength: 1,
          modifiedAt: "2026-08-01T00:00:00.000Z",
        },
        {
          clientRef: "a",
          path: "a.jsonl",
          offset: 0,
          byteLength: 1,
          modifiedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      Buffer.from("ab"),
    ],
    [
      "zero-length part",
      [
        {
          clientRef: "a",
          path: "a.jsonl",
          offset: 0,
          byteLength: 0,
          modifiedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      Buffer.alloc(0),
    ],
  ] as const)("rejects %s in framed manifests", async (_name, parts, payload) => {
    const app = buildApp({ services: services([]) });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/imports/candidates",
      headers: { "content-type": "application/vnd.intenttrace.session-bundle" },
      payload: rawFrame({ protocolVersion: 1, source: "codex", candidateIds: [], parts }, payload),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("invalid_session_bundle");
  });

  it("requires empty inspection IDs and non-empty import IDs", async () => {
    const app = buildApp({ services: services([]) });
    apps.push(app);
    const bytes = await codexFixture();
    const inspectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/imports/candidates",
      headers: { "content-type": "application/vnd.intenttrace.session-bundle" },
      payload: frame([{ clientRef: "c1", path: "valid.jsonl", bytes }], "codex", ["a".repeat(24)]),
    });
    expect(inspectResponse.statusCode).toBe(400);
    const importResponse = await app.inject({
      method: "POST",
      url: "/api/v1/imports/sessions",
      headers: { "content-type": "application/vnd.intenttrace.session-bundle" },
      payload: frame([{ clientRef: "c1", path: "valid.jsonl", bytes }], "codex", []),
    });
    expect(importResponse.statusCode).toBe(400);
  });

  it("returns validation_failed for syntactically malformed JSON", async () => {
    const app = buildApp({ services: services([]) });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/imports/candidates",
      headers: { "content-type": "application/json" },
      payload: '{"protocolVersion":2,"includePreviews":false,"parts":',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("validation_failed");
  });

  it("truncates incomplete text heads to the last newline", async () => {
    const app = buildApp({ services: services([]) });
    apps.push(app);
    const complete = await codexFixture();
    const cut = Buffer.concat([complete, Buffer.from('{"type":"event_msg","payload":')]);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/imports/candidates",
      payload: {
        protocolVersion: 2,
        includePreviews: false,
        parts: [
          {
            clientRef: "c1",
            path: "valid.jsonl",
            byteLength: cut.byteLength + 100,
            modifiedAt: "2026-08-01T00:00:00.000Z",
            headBase64: cut.toString("base64"),
            complete: false,
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().candidates[0]).toMatchObject({ source: "codex", partialHead: true });
  });

  it("rejects canonical-only sources at the framed import boundary", async () => {
    const app = buildApp({ services: services([]) });
    apps.push(app);
    const bytes = await codexFixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/imports/sessions",
      headers: { "content-type": "application/vnd.intenttrace.session-bundle" },
      payload: rawFrame(
        {
          protocolVersion: 1,
          source: "pi",
          candidateIds: ["a".repeat(24)],
          parts: [
            {
              clientRef: "c1",
              path: "valid.jsonl",
              offset: 0,
              byteLength: bytes.byteLength,
              modifiedAt: "2026-08-01T00:00:00.000Z",
            },
          ],
        },
        bytes,
      ),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("invalid_session_bundle");
  });

  it("bounds explicit-source candidate roots without dropping companions", async () => {
    const app = buildApp({ services: services([]) });
    apps.push(app);
    const root = Buffer.from(
      '{"type":"user","sessionId":"root","message":{"role":"user","content":"x"}}\n',
    );
    const parts = [
      { clientRef: "root", path: "root.jsonl", bytes: root },
      ...Array.from({ length: 51 }, (_, index) => ({
        clientRef: `side-${index}`,
        path: `subagents/agent-${index}.meta.json`,
        bytes: Buffer.from(JSON.stringify({ sessionId: "root" })),
      })),
    ];
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/imports/candidates",
      headers: { "content-type": "application/vnd.intenttrace.session-bundle" },
      payload: frame(parts, "claude", []),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().candidates).toHaveLength(1);
    expect(response.json().candidates[0].partRefs).toHaveLength(52);
  });

  it("caps explicit-source candidate roots at 50", async () => {
    const app = buildApp({ services: services([]) });
    apps.push(app);
    const parts = Array.from({ length: 51 }, (_, index) => ({
      clientRef: `root-${index}`,
      path: `root-${index}.jsonl`,
      bytes: Buffer.from(`{"type":"session_meta","payload":{"id":"root-${index}"}}\n`),
    }));
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/imports/candidates",
      headers: { "content-type": "application/vnd.intenttrace.session-bundle" },
      payload: frame(parts, "codex", []),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().candidates).toHaveLength(50);
  });

  it("keeps mixed-source companions scoped to their detected roots", async () => {
    const app = buildApp({ services: services([]) });
    apps.push(app);
    const codex = await codexFixture();
    const claude = await claudeFixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/imports/candidates",
      payload: {
        protocolVersion: 2,
        includePreviews: false,
        parts: [
          {
            clientRef: "codex",
            path: "codex.jsonl",
            byteLength: codex.byteLength,
            modifiedAt: "2026-08-01T00:00:00.000Z",
            headBase64: codex.toString("base64"),
            complete: true,
          },
          {
            clientRef: "claude",
            path: "claude.jsonl",
            byteLength: claude.byteLength,
            modifiedAt: "2026-08-01T00:00:00.000Z",
            headBase64: claude.toString("base64"),
            complete: true,
          },
          {
            clientRef: "claude-meta",
            path: "subagents/agent.meta.json",
            byteLength: 22,
            modifiedAt: "2026-08-01T00:00:00.000Z",
            headBase64: Buffer.from('{"sessionId":"session-1"}').toString("base64"),
            complete: true,
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    const candidates = response.json().candidates as Array<{ source: string; partRefs: string[] }>;
    expect(candidates.find((candidate) => candidate.source === "codex")?.partRefs).toEqual([
      "codex",
    ]);
  });
});
