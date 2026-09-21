import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { computeSessionCandidateId } from "@intenttrace/adapters";

import {
  collectorCandidateId,
  formatCollectorFatalError,
  HELP_TEXT,
  runCollector,
} from "../src/cli.js";
import { discoverSessionFiles } from "../src/session-discovery.js";
import { validateExplicitPath } from "../src/path-policy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function mockFetch() {
  let sequence = 0;
  return async (_input: string | URL | Request, init?: RequestInit) => {
    const request = init?.body;
    if (request instanceof Blob) {
      const bytes = new Uint8Array(await request.arrayBuffer());
      expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("ITB1");
      const manifestLength = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      ).getUint32(4);
      const manifest = JSON.parse(
        new TextDecoder().decode(bytes.subarray(8, 8 + manifestLength)),
      ) as { candidateIds: string[] };
      return new Response(
        JSON.stringify({
          protocolVersion: 2,
          level: "result",
          command: "upload",
          results: manifest.candidateIds.map((candidateId) => ({
            candidateId,
            sessionId: "b".repeat(24),
            traceId: "33333333-3333-4333-8333-333333333333",
            inserted: 2,
            duplicates: 0,
            warnings: 0,
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const event = JSON.parse(String(request)) as Record<string, unknown>;
    delete event.workspaceName;
    delete event.projectName;
    delete event.traceTitle;
    delete event.payload;
    sequence += 1;
    return new Response(
      JSON.stringify({
        event: {
          ...event,
          id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
          ingestSeq: String(sequence),
          ingestedAt: "2026-08-03T00:00:00.000Z",
        },
        duplicate: false,
        traceStale: false,
        warnings: [],
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  };
}

describe("collector path boundary", () => {
  it("documents the fixed command surface", () => {
    expect(HELP_TEXT).toContain(
      "intenttrace discover --source jsonl|otlp|codex|claude|opencode|omp|grok --path <path>",
    );
    expect(HELP_TEXT).toContain(
      "intenttrace import --source jsonl|otlp|codex|claude|opencode|omp|grok --path <path>",
    );
    expect(HELP_TEXT).toContain("[--session <opaque-id> ...]");
    expect(HELP_TEXT).toContain("intenttrace follow --source codex|claude --path <path>");
    expect(HELP_TEXT).toContain("follow_requires_single_file");
  });

  it("sends an import as one framed bundle request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intenttrace-collector-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "session.jsonl");
    await writeFile(path, '{"type":"session_meta","payload":{"id":"session-1"}}\n');
    const requests: Array<{ url: string; contentType: string | null }> = [];
    await expect(
      runCollector(["import", "--source", "codex", "--path", path], {
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          requests.push({
            url: String(input),
            contentType: new Headers(init?.headers).get("content-type"),
          });
          const body = init?.body as Blob;
          const bytes = new Uint8Array(await body.arrayBuffer());
          const manifestLength = new DataView(bytes.buffer).getUint32(4);
          const manifest = JSON.parse(
            new TextDecoder().decode(bytes.subarray(8, 8 + manifestLength)),
          ) as { candidateIds: string[] };
          return new Response(
            JSON.stringify({
              protocolVersion: 2,
              level: "result",
              command: "upload",
              results: manifest.candidateIds.map((id) => ({
                candidateId: id,
                sessionId: "b".repeat(24),
                traceId: "33333333-3333-4333-8333-333333333333",
                inserted: 2,
                duplicates: 0,
                warnings: 0,
              })),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as typeof fetch,
        output: () => {},
        environment: {},
      }),
    ).resolves.toBe(0);
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:3001/api/v1/imports/sessions",
        contentType: "application/vnd.intenttrace.session-bundle",
      },
    ]);
  });

  it("reports bundle follow rejection visibly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intenttrace-collector-"));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, "session.jsonl"),
      '{"type":"session_meta","payload":{"id":"session-1"}}\n',
    );
    await expect(
      runCollector(["follow", "--source", "codex", "--path", directory, "--once"], {
        fetch: mockFetch() as typeof fetch,
        output: () => {},
        environment: {},
      }),
    ).rejects.toThrow("follow_requires_single_file");
  });

  it("redacts absolute paths from fatal filesystem diagnostics", () => {
    const error = Object.assign(new Error("ENOENT at /private/home/alice/session.jsonl"), {
      code: "ENOENT",
    });
    expect(formatCollectorFatalError(error)).toBe(
      "Unable to access the explicitly authorized path (ENOENT)",
    );
    expect(formatCollectorFatalError(error)).not.toContain("/private/home/alice");
  });

  it("accepts the legacy pnpm script separator", async () => {
    const output: string[] = [];
    await expect(
      runCollector(["--", "--help"], {
        fetch: mockFetch() as typeof fetch,
        output: (line) => output.push(line),
        environment: {},
      }),
    ).resolves.toBe(0);
    expect(output.join("\n")).toContain("intenttrace discover");
  });

  it("accepts an explicitly named regular file without reading it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intenttrace-collector-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "session.jsonl");
    await writeFile(path, "secret-not-read-by-validator\n");
    await expect(validateExplicitPath(path)).resolves.toMatchObject({
      kind: "file",
      realPath: path,
    });
  });

  it("refuses a symlink as the explicit boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intenttrace-collector-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "target.jsonl");
    const link = join(directory, "link.jsonl");
    await writeFile(target, "fixture\n");
    await symlink(target, link);
    await expect(validateExplicitPath(link)).rejects.toThrow("Symbolic-link paths are refused");
  });

  it("refuses to send raw sessions to a non-loopback API origin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intenttrace-collector-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "session.jsonl");
    await writeFile(path, '{"type":"session_meta","payload":{"id":"local-only"}}\n');
    let fetchCalls = 0;
    await expect(
      runCollector(
        ["import", "--source", "codex", "--path", path, "--api", "https://collector.example.com"],
        {
          fetch: (async () => {
            fetchCalls += 1;
            throw new Error("must not egress");
          }) as typeof fetch,
          output: () => {},
          environment: {},
        },
      ),
    ).rejects.toThrow("Collector API origin must be loopback");
    expect(fetchCalls).toBe(0);
  });

  it("imports normalized events through the API boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intenttrace-collector-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "session.jsonl");
    await writeFile(
      path,
      '{"type":"session_meta","version":"codex-jsonl-v1","timestamp":"2026-08-01T00:00:00.000Z","payload":{"id":"session-1","agent_id":"orchestrator"}}\n',
    );
    const output: string[] = [];
    await expect(
      runCollector(["import", "--source", "codex", "--path", path], {
        fetch: mockFetch() as typeof fetch,
        output: (line) => output.push(line),
        environment: {},
      }),
    ).resolves.toBe(0);
    expect(output.at(-1)).toContain('"inserted":2');
  });

  it("adds repository ingest warnings to import warning totals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intenttrace-collector-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "session.jsonl");
    await writeFile(
      path,
      '{"type":"session_meta","version":"codex-jsonl-v1","timestamp":"2026-08-01T00:00:00.000Z","payload":{"id":"session-1","agent_id":"orchestrator"}}\n',
    );
    const output: string[] = [];
    const repositoryWarningFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const receiver = mockFetch();
      const response = await receiver(input, init);
      const body = (await response.json()) as {
        results: Array<{ warnings: number }>;
      };
      for (const result of body.results) result.warnings = 2;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      runCollector(["import", "--source", "codex", "--path", path], {
        fetch: repositoryWarningFetch as typeof fetch,
        output: (line) => output.push(line),
        environment: {},
      }),
    ).resolves.toBe(0);

    expect(JSON.parse(output.at(-1)!)).toMatchObject({ warnings: 2 });
  });

  it("discovers a sanitized recent-session catalog without contacting the API", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intenttrace-collector-"));
    temporaryDirectories.push(directory);
    const sessionId = "native-session-id-must-not-be-listed";
    const path = join(directory, `${sessionId}.jsonl`);
    await writeFile(
      path,
      `${JSON.stringify({
        type: "user",
        sessionId,
        cwd: "/private/home/alice/projects/acme",
        timestamp: "2026-08-01T00:00:00.000Z",
        message: { role: "user", content: "Review the failing checkout flow" },
      })}\n`,
    );
    let fetchCalls = 0;
    const output: string[] = [];
    await expect(
      runCollector(["discover", "--source", "claude", "--path", directory, "--include-previews"], {
        fetch: (async () => {
          fetchCalls += 1;
          throw new Error("discover must not call fetch");
        }) as typeof fetch,
        output: (line) => output.push(line),
        environment: {},
      }),
    ).resolves.toBe(0);

    expect(fetchCalls).toBe(0);
    const serialized = output.at(-1)!;
    const catalog = JSON.parse(serialized) as {
      sessions: Array<Record<string, unknown>>;
      failed: unknown[];
    };
    expect(catalog.failed).toEqual([]);
    expect(catalog.sessions).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^[a-f0-9]{24}$/u),
        source: "claude",
        projectHint: "acme",
        title: "Claude · Review the failing checkout flow",
        firstPromptPreview: "Review the failing checkout flow",
        lastPromptPreview: "Review the failing checkout flow",
        eventCount: 1,
      }),
    ]);
    expect(serialized).not.toContain(directory);
    expect(serialized).not.toContain("/private/home/alice");
    expect(serialized).not.toContain(sessionId);
  });

  it("hides prompt content unless discovery explicitly includes previews", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intenttrace-collector-"));
    temporaryDirectories.push(directory);
    const privatePrompt = "Private checkout incident details";
    await writeFile(
      join(directory, "session.jsonl"),
      `${JSON.stringify({
        type: "user",
        sessionId: "session-private",
        timestamp: "2026-08-01T00:00:00.000Z",
        message: { role: "user", content: privatePrompt },
      })}\n`,
    );
    const output: string[] = [];
    await runCollector(["discover", "--source", "claude", "--path", directory], {
      fetch: mockFetch() as typeof fetch,
      output: (line) => output.push(line),
      environment: {},
    });
    expect(output.at(-1)).not.toContain(privatePrompt);
    expect(JSON.parse(output.at(-1)!).sessions[0]).toMatchObject({
      title: "Claude session",
      firstPromptPreview: null,
      lastPromptPreview: null,
    });
  });

  it("imports only selected opaque catalog IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intenttrace-collector-"));
    temporaryDirectories.push(directory);
    const record = (id: string, prompt: string) =>
      `${JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T00:00:00.000Z",
        payload: { type: "user_message", id, message: prompt },
      })}\n`;
    await writeFile(join(directory, "a.jsonl"), record("event-a", "Import alpha"));
    await writeFile(join(directory, "b.jsonl"), record("event-b", "Import beta"));

    const discoveryOutput: string[] = [];
    await runCollector(
      ["discover", "--source", "codex", "--path", directory, "--include-previews"],
      {
        fetch: mockFetch() as typeof fetch,
        output: (line) => discoveryOutput.push(line),
        environment: {},
      },
    );
    const catalog = JSON.parse(discoveryOutput.at(-1)!) as {
      sessions: Array<{ id: string; title: string }>;
    };
    const selected = catalog.sessions.find((session) => session.title.includes("beta"))!;
    let sent = 0;
    const output: string[] = [];
    const receiver = mockFetch();
    await expect(
      runCollector(["import", "--source", "codex", "--path", directory, "--session", selected.id], {
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          sent += 1;
          return receiver(input, init);
        }) as typeof fetch,
        output: (line) => output.push(line),
        environment: {},
      }),
    ).resolves.toBe(0);
    expect(sent).toBe(1);
    const result = output.map((line) => JSON.parse(line)).find((line) => line.level === "result");
    expect(result).toMatchObject({
      protocolVersion: 2,
      command: "upload",
      sessionId: selected.id,
      inserted: 2,
      duplicates: 0,
    });
    expect(JSON.stringify(result)).not.toContain(directory);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({
      protocolVersion: 1,
      level: "summary",
      matchedFiles: 2,
      files: 1,
      imported: 1,
      missingSessionIds: [],
    });
  });

  it("never falls back to bulk import when --session has no value", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intenttrace-collector-"));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, "session.jsonl"),
      '{"type":"session_meta","payload":{"id":"must-not-import"}}\n',
    );
    let fetchCalls = 0;
    await expect(
      runCollector(["import", "--source", "codex", "--path", directory, "--session"], {
        fetch: (async () => {
          fetchCalls += 1;
          throw new Error("invalid selection must not import");
        }) as typeof fetch,
        output: () => {},
        environment: {},
      }),
    ).rejects.toThrow("--session requires a value");
    expect(fetchCalls).toBe(0);
  });

  it("rejects a stale catalog selection after the file changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intenttrace-collector-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "session.jsonl");
    const line = (id: string) =>
      `${JSON.stringify({
        type: "event_msg",
        timestamp: "2026-08-01T00:00:00.000Z",
        payload: { type: "user_message", id, message: id },
      })}\n`;
    await writeFile(path, line("before"));
    const discoveryOutput: string[] = [];
    await runCollector(["discover", "--source", "codex", "--path", directory], {
      fetch: mockFetch() as typeof fetch,
      output: (value) => discoveryOutput.push(value),
      environment: {},
    });
    const staleId = JSON.parse(discoveryOutput.at(-1)!).sessions[0].id as string;
    await writeFile(path, `${line("before")}${line("after")}`);

    let fetchCalls = 0;
    const output: string[] = [];
    await expect(
      runCollector(["import", "--source", "codex", "--path", directory, "--session", staleId], {
        fetch: (async () => {
          fetchCalls += 1;
          throw new Error("stale selection must not import");
        }) as typeof fetch,
        output: (value) => output.push(value),
        environment: {},
      }),
    ).resolves.toBe(1);
    expect(fetchCalls).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({
      files: 0,
      imported: 0,
      missingSessionIds: [staleId],
    });
  });

  it("rejects files above the configured size limit before reading or sending", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intenttrace-collector-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "oversized.jsonl");
    await writeFile(path, Buffer.alloc(1024 * 1024 + 1, 0x20));
    let fetchCalls = 0;
    const output: string[] = [];
    await expect(
      runCollector(
        ["import", "--source", "codex", "--path", path, "--max-file-mib", "1", "--dry-run"],
        {
          fetch: (async () => {
            fetchCalls += 1;
            throw new Error("oversized preflight must not send");
          }) as typeof fetch,
          output: (value) => output.push(value),
          environment: {},
        },
      ),
    ).resolves.toBe(1);
    expect(fetchCalls).toBe(0);
    expect(JSON.parse(output.at(-1)!).failed).toEqual([
      expect.objectContaining({ message: "Session exceeds the configured file-size limit" }),
    ]);
  });

  it("preflights a complete file before sending and redacts malformed source text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intenttrace-collector-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "broken.jsonl");
    const secretSourceText = "DO_NOT_ECHO_THIS_SOURCE_TEXT";
    await writeFile(
      path,
      `{"type":"session_meta","payload":{"id":"session-good-prefix"}}\n{"broken":"${secretSourceText}\n`,
    );
    let fetchCalls = 0;
    const output: string[] = [];
    await expect(
      runCollector(["import", "--source", "codex", "--path", path], {
        fetch: (async () => {
          fetchCalls += 1;
          throw new Error("must not send a partial import");
        }) as typeof fetch,
        output: (line) => output.push(line),
        environment: {},
      }),
    ).resolves.toBe(1);
    expect(fetchCalls).toBe(0);
    expect(output.join("\n")).not.toContain(secretSourceText);
    expect(output.join("\n")).not.toContain(directory);
    expect(output.join("\n")).toContain("Session preflight failed; no events were imported");
  });

  it("walks nested session directories and skips symlinks and unrelated files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intenttrace-collector-"));
    temporaryDirectories.push(directory);
    const record = (id: string) =>
      `{"type":"session_meta","version":"codex-jsonl-v1","timestamp":"2026-08-01T00:00:00.000Z","payload":{"id":"${id}","agent_id":"orchestrator"}}\n`;
    // Codex nests sessions under YYYY/MM/DD; Claude nests one directory per project.
    await mkdir(join(directory, "2026", "08", "01"), { recursive: true });
    await mkdir(join(directory, "2026", "08", "02"), { recursive: true });
    await writeFile(join(directory, "2026", "08", "01", "a.jsonl"), record("session-a"));
    await writeFile(join(directory, "2026", "08", "02", "b.jsonl"), record("session-b"));
    await writeFile(join(directory, "2026", "08", "02", "notes.txt"), "ignored\n");
    await symlink(
      join(directory, "2026", "08", "01", "a.jsonl"),
      join(directory, "2026", "linked.jsonl"),
    );

    const output: string[] = [];
    await expect(
      runCollector(["import", "--source", "codex", "--path", directory, "--dry-run"], {
        fetch: mockFetch() as typeof fetch,
        output: (line) => output.push(line),
        environment: {},
      }),
    ).resolves.toBe(0);
    const summary = JSON.parse(output.at(-1)!) as {
      matchedFiles: number;
      selectedFiles: number;
      skippedByLimit: number;
      sessions: Array<{ id: string; source: string; eventCount: number }>;
    };
    expect(summary.matchedFiles).toBe(2);
    expect(summary.selectedFiles).toBe(2);
    expect(summary.skippedByLimit).toBe(0);
    expect(summary.sessions).toHaveLength(2);
    expect(summary.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^[a-f0-9]{24}$/u),
          source: "codex",
          eventCount: 1,
        }),
      ]),
    );
  });

  it("reports the skipped count instead of silently truncating at --max-files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intenttrace-collector-"));
    temporaryDirectories.push(directory);
    const record = (id: string) =>
      `{"type":"session_meta","version":"codex-jsonl-v1","timestamp":"2026-08-01T00:00:00.000Z","payload":{"id":"${id}","agent_id":"orchestrator"}}\n`;
    for (const name of ["a", "b", "c"]) {
      await writeFile(join(directory, `${name}.jsonl`), record(`session-${name}`));
    }
    const output: string[] = [];
    await runCollector(
      ["import", "--source", "codex", "--path", directory, "--max-files", "2", "--dry-run"],
      {
        fetch: mockFetch() as typeof fetch,
        output: (line) => output.push(line),
        environment: {},
      },
    );
    expect(JSON.parse(output.at(-1)!)).toMatchObject({
      matchedFiles: 3,
      selectedFiles: 2,
      skippedByLimit: 1,
    });
  });

  it("keeps importing after one session fails and reports the failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intenttrace-collector-"));
    temporaryDirectories.push(directory);
    const record = (id: string) =>
      `{"type":"session_meta","version":"codex-jsonl-v1","timestamp":"2026-08-01T00:00:00.000Z","payload":{"id":"${id}","agent_id":"orchestrator"}}\n`;
    await writeFile(join(directory, "good.jsonl"), record("session-good"));
    await writeFile(join(directory, "later.jsonl"), record("session-later"));
    const failing = mockFetch();
    let calls = 0;
    const output: string[] = [];
    const exitCode = await runCollector(
      ["import", "--source", "codex", "--path", directory, "--concurrency", "1"],
      {
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          calls += 1;
          if (calls === 1) return new Response("{}", { status: 500 });
          return failing(input, init);
        }) as typeof fetch,
        output: (line) => output.push(line),
        environment: {},
      },
    );
    expect(exitCode).toBe(1);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ files: 2, imported: 1, failed: 1 });
  });

  it("records append, truncation, and rotation checkpoints without scanning directories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intenttrace-collector-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "session.jsonl");
    const state = join(directory, "state");
    const outputs: string[] = [];
    const dependencies = {
      fetch: mockFetch() as typeof fetch,
      output: (line: string) => outputs.push(line),
      environment: { INTENTTRACE_COLLECTOR_STATE: state },
    };
    const record = (id: string) =>
      `{"type":"session_meta","version":"codex-jsonl-v1","timestamp":"2026-08-01T00:00:00.000Z","payload":{"id":"${id}","agent_id":"orchestrator"}}\n`;
    await writeFile(path, record("session-with-a-long-identity"));
    await runCollector(["follow", "--source", "codex", "--path", path, "--once"], dependencies);
    await writeFile(path, record("session-2"));
    await runCollector(["follow", "--source", "codex", "--path", path, "--once"], dependencies);
    await rename(path, `${path}.rotated`);
    await writeFile(path, record("session-3"));
    await runCollector(["follow", "--source", "codex", "--path", path, "--once"], dependencies);
    expect(outputs.some((line) => line.includes('"truncated":true'))).toBe(true);
    expect(outputs.some((line) => line.includes('"rotated":true'))).toBe(true);
  });

  it("groups Claude root and sidecars into one collector candidate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intenttrace-collector-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "subagents"));
    await writeFile(join(directory, "root.jsonl"), '{"type":"user","sessionId":"root"}\n');
    await writeFile(
      join(directory, "subagents", "agent-child.jsonl"),
      '{"type":"assistant","sessionId":"root","agentId":"child"}\n',
    );
    await writeFile(join(directory, "subagents", "agent-child.meta.json"), '{"sessionId":"root"}');
    const root = await validateExplicitPath(directory);
    const discovered = await discoverSessionFiles({
      source: "claude",
      root,
      limit: 50,
      newestFirst: false,
    });
    expect(discovered.candidates).toHaveLength(1);
    expect(discovered.candidates[0]?.parts.map((part) => part.relativePath)).toEqual([
      "root.jsonl",
      "subagents/agent-child.jsonl",
      "subagents/agent-child.meta.json",
    ]);
  });

  it("groups OpenCode database and WAL into one collector candidate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intenttrace-collector-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "opencode.db"), "db");
    await writeFile(join(directory, "opencode.db-wal"), "wal");
    const root = await validateExplicitPath(directory);
    const discovered = await discoverSessionFiles({
      source: "opencode",
      root,
      limit: 50,
      newestFirst: false,
    });
    expect(discovered.candidates).toHaveLength(1);
    expect(discovered.candidates[0]?.parts.map((part) => part.relativePath)).toEqual([
      "opencode.db",
      "opencode.db-wal",
    ]);
  });

  it("uses the shared logical suffix for multi-trace candidate IDs", () => {
    const candidate = {
      id: "a".repeat(24),
      internalCandidateId: "b".repeat(24),
      logicalRootIdentity: "root",
      parts: [],
      byteLength: 1,
      modifiedAt: "2026-08-01T00:00:00.000Z",
      modifiedAtMs: 1,
      normalizationIdentity: "bundle-test",
    };
    const prepared = {
      candidate,
      parts: [
        {
          path: "root.jsonl",
          bytes: new Uint8Array([1]),
          clientRef: "p1",
          modifiedAt: candidate.modifiedAt,
        },
      ],
      contentSha256: "c".repeat(64),
      events: [],
      warnings: [],
      descriptor: {} as never,
      completionMarker: {} as never,
      logicalIndex: 1,
      logicalCount: 2,
    };
    expect(collectorCandidateId("jsonl", prepared)).toBe(
      computeSessionCandidateId("jsonl", "root:logical-2", ["root.jsonl"]),
    );
  });
});
