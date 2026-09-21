import { describe, expect, it } from "vitest";

import {
  ALL_SOURCES,
  buildSessionBundleFrame,
  candidateRowsFromResponse,
  CANDIDATE_WINDOW,
  computeEmptyState,
  dedupeKey,
  fileRelativePath,
  groupSelectedBundles,
  rankCandidates,
  summarize,
  visibleRows,
  type ImportRow,
} from "./view-model";

function file(name: string, lastModified: number, size = 10): File {
  return new File(["x".repeat(size)], name, { lastModified });
}

function row(overrides: Partial<ImportRow> & { clientRef: string }): ImportRow {
  const source = file(`${overrides.clientRef}.jsonl`, 0);
  return {
    path: source.name,
    key: dedupeKey(source),
    file: source,
    name: source.name,
    size: source.size,
    lastModified: 0,
    candidateId: null,
    partRefs: [overrides.clientRef],
    status: "ready",
    selected: false,
    source: null,
    title: null,
    projectHint: null,
    firstPromptPreview: null,
    lastPromptPreview: null,
    partialHead: false,
    imported: false,
    traceId: null,
    inserted: 0,
    duplicates: 0,
    failureCode: null,
    failureMessage: null,
    failureStage: null,
    ...overrides,
  };
}

describe("rankCandidates", () => {
  it("keeps whole-document JSON only for an explicit file pick", () => {
    const files = [file("a.json", 3), file("b.jsonl", 2), file("c.ndjson", 1)];
    expect(rankCandidates(files, "files").window.map((entry) => entry.name)).toEqual([
      "a.json",
      "b.jsonl",
      "c.ndjson",
    ]);
    const folder = rankCandidates(files, "folder");
    expect(folder.window.map((entry) => entry.name)).toEqual(["b.jsonl", "c.ndjson"]);
    expect(folder.ignored).toBe(1);
  });

  it("sorts newest first and breaks ties by name", () => {
    const ranked = rankCandidates(
      [file("b.jsonl", 5), file("a.jsonl", 5), file("z.jsonl", 9)],
      "folder",
    );
    expect(ranked.window.map((entry) => entry.name)).toEqual(["z.jsonl", "a.jsonl", "b.jsonl"]);
  });

  it("caps the window and reports what the cap dropped", () => {
    const files = Array.from({ length: CANDIDATE_WINDOW + 3 }, (_, index) =>
      file(`s${index}.jsonl`, index),
    );
    const ranked = rankCandidates(files, "folder");
    expect(ranked.window).toHaveLength(CANDIDATE_WINDOW);
    expect(ranked.skippedByLimit).toBe(3);
  });

  it("is first-wins on identical name, size, and mtime", () => {
    const ranked = rankCandidates([file("a.jsonl", 1), file("a.jsonl", 1)], "folder");
    expect(ranked.window).toHaveLength(1);
  });
});

describe("browser bundle transport", () => {
  it("retains webkitRelativePath for folder picks and basename for files", () => {
    const folderFile = file("root.jsonl", 1);
    Object.defineProperty(folderFile, "webkitRelativePath", { value: "project/root.jsonl" });
    expect(fileRelativePath(folderFile, "folder")).toBe("project/root.jsonl");
    expect(fileRelativePath(folderFile, "files")).toBe("root.jsonl");
  });

  it("builds ITB1 frames with sorted unique part groups", async () => {
    const a = file("a.jsonl", 1, 3);
    const b = file("b.jsonl", 2, 2);
    const rows = [
      row({
        clientRef: "c1",
        file: a,
        name: a.name,
        candidateId: "a".repeat(24),
        partRefs: ["c1", "c2"],
      }),
      row({
        clientRef: "c2",
        file: b,
        name: b.name,
        candidateId: "b".repeat(24),
        partRefs: ["c1", "c2"],
      }),
    ];
    const grouped = groupSelectedBundles(rows);
    expect(grouped.failures).toEqual([]);
    expect(grouped.groups).toHaveLength(1);
    expect(grouped.groups[0]?.candidateIds).toEqual(["a".repeat(24), "b".repeat(24)]);
    const blob = await buildSessionBundleFrame(
      grouped.groups[0]!.parts,
      "auto",
      grouped.groups[0]!.candidateIds,
    );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("ITB1");
    expect(new DataView(bytes.buffer).getUint32(4)).toBeGreaterThan(0);
  });

  it("keeps companion extensions in folder metadata", () => {
    const ranked = rankCandidates(
      [file("agent.meta.json", 1), file("opencode.db", 2), file("opencode.db-wal", 3)],
      "folder",
    );
    expect(ranked.window.map((entry) => entry.name)).toEqual([
      "opencode.db",
      "opencode.db-wal",
      "agent.meta.json",
    ]);
  });

  it("windows folder roots while retaining companions", () => {
    const roots = Array.from({ length: CANDIDATE_WINDOW + 1 }, (_, index) =>
      file(`root-${index}.jsonl`, 100 - index),
    );
    const companion = file("agent.meta.json", 0);
    Object.defineProperty(companion, "webkitRelativePath", { value: "subagents/agent.meta.json" });
    const ranked = rankCandidates([...roots, companion], "folder");
    expect(ranked.window).toContain(companion);
    expect(ranked.window.filter((entry) => entry.name.endsWith(".jsonl"))).toHaveLength(
      CANDIDATE_WINDOW,
    );
    expect(ranked.skippedByLimit).toBe(1);
  });

  it("retains OMP same-stem children only for windowed roots", () => {
    const roots = Array.from({ length: CANDIDATE_WINDOW + 1 }, (_, index) => {
      const root = file(`root-${index}.jsonl`, 100 - index);
      Object.defineProperty(root, "webkitRelativePath", { value: `root-${index}.jsonl` });
      return root;
    });
    const selectedChild = file("child.jsonl", 0);
    Object.defineProperty(selectedChild, "webkitRelativePath", { value: "root-0/child.jsonl" });
    const skippedChild = file("child.jsonl", 0);
    Object.defineProperty(skippedChild, "webkitRelativePath", {
      value: `root-${CANDIDATE_WINDOW}/child.jsonl`,
    });
    const ranked = rankCandidates([...roots, selectedChild, skippedChild], "folder");
    expect(ranked.window).toContain(selectedChild);
    expect(ranked.window).not.toContain(skippedChild);
  });

  it("drops Claude and OpenCode companions for roots outside the window", () => {
    const roots = Array.from({ length: CANDIDATE_WINDOW + 1 }, (_, index) => {
      const root = file(`root-${index}.jsonl`, 100 - index);
      Object.defineProperty(root, "webkitRelativePath", {
        value: `project-${index}/root-${index}.jsonl`,
      });
      return root;
    });
    const selectedMeta = file("agent.meta.json", 0);
    Object.defineProperty(selectedMeta, "webkitRelativePath", {
      value: "project-0/subagents/agent.meta.json",
    });
    const skippedMeta = file("agent.meta.json", 0);
    Object.defineProperty(skippedMeta, "webkitRelativePath", {
      value: `project-${CANDIDATE_WINDOW}/subagents/agent.meta.json`,
    });
    const selectedDb = file("opencode.db", 99);
    Object.defineProperty(selectedDb, "webkitRelativePath", { value: "selected/opencode.db" });
    const selectedWal = file("opencode.db-wal", 0);
    Object.defineProperty(selectedWal, "webkitRelativePath", { value: "selected/opencode.db-wal" });
    const skippedWal = file("other.db-wal", 0);
    Object.defineProperty(skippedWal, "webkitRelativePath", { value: "unselected/other.db-wal" });
    const ranked = rankCandidates(
      [...roots, selectedDb, selectedMeta, skippedMeta, selectedWal, skippedWal],
      "folder",
    );
    expect(ranked.window).toContain(selectedMeta);
    expect(ranked.window).toContain(selectedWal);
    expect(ranked.window).not.toContain(skippedMeta);
    expect(ranked.window).not.toContain(skippedWal);
  });

  it("creates distinct rows when one part yields several logical traces", () => {
    const source = row({ clientRef: "c1" });
    const candidates = candidateRowsFromResponse(
      [source],
      [
        {
          clientRef: "c1:logical-1",
          candidateId: "a".repeat(24),
          partRefs: ["c1"],
          source: "jsonl",
          title: "Trace A",
          projectHint: null,
          firstPromptPreview: null,
          lastPromptPreview: null,
          partialHead: false,
          traceId: "11111111-1111-4111-8111-111111111111",
          imported: false,
          importedEventCount: null,
          failureCode: null,
          failureMessage: null,
        },
        {
          clientRef: "c1:logical-2",
          candidateId: "b".repeat(24),
          partRefs: ["c1"],
          source: "jsonl",
          title: "Trace B",
          projectHint: null,
          firstPromptPreview: null,
          lastPromptPreview: null,
          partialHead: false,
          traceId: "22222222-2222-4222-8222-222222222222",
          imported: false,
          importedEventCount: null,
          failureCode: null,
          failureMessage: null,
        },
      ],
    );
    expect(candidates.map((entry) => entry.candidateId)).toEqual(["a".repeat(24), "b".repeat(24)]);
    expect(candidates.map((entry) => entry.clientRef)).toEqual(["c1:logical-1", "c1:logical-2"]);
  });

  it("reports missing companion groups without throwing", () => {
    const groups = groupSelectedBundles([
      row({ clientRef: "c1", candidateId: "a".repeat(24), partRefs: ["c1", "missing"] }),
    ]);
    expect(groups.groups).toEqual([]);
    expect(groups.failures).toEqual([
      { rowRefs: ["c1"], message: "Missing selected part missing" },
    ]);
  });

  it("builds groups from a separate part store", () => {
    const root = row({
      clientRef: "candidate",
      candidateId: "a".repeat(24),
      partRefs: ["p1", "p2"],
    });
    const p1 = row({ clientRef: "p1" });
    const p2 = row({ clientRef: "p2" });
    const grouped = groupSelectedBundles([root], [p1, p2]);
    expect(grouped.failures).toEqual([]);
    expect(grouped.groups[0]?.parts.map((part) => part.clientRef)).toEqual(["p1", "p2"]);
  });
});

describe("visibleRows", () => {
  const rows = [
    row({ clientRef: "c1", name: "alpha.jsonl", title: "Codex · fix build", source: "codex" }),
    row({ clientRef: "c2", name: "beta.jsonl", source: "claude", imported: true }),
  ];

  it("matches file name and title but never prompt text", () => {
    const withPreview = [
      row({ clientRef: "c3", name: "gamma.jsonl", firstPromptPreview: "secret phrase" }),
    ];
    expect(
      visibleRows(withPreview, { query: "secret", source: ALL_SOURCES, hideImported: false }),
    ).toHaveLength(0);
    expect(
      visibleRows(rows, { query: "fix build", source: ALL_SOURCES, hideImported: false }).map(
        (entry) => entry.clientRef,
      ),
    ).toEqual(["c1"]);
  });

  it("filters by detected source and hides already-imported rows", () => {
    expect(
      visibleRows(rows, { query: "", source: "claude", hideImported: false }).map(
        (entry) => entry.clientRef,
      ),
    ).toEqual(["c2"]);
    expect(
      visibleRows(rows, { query: "", source: ALL_SOURCES, hideImported: true }).map(
        (entry) => entry.clientRef,
      ),
    ).toEqual(["c1"]);
  });
});

describe("computeEmptyState", () => {
  const base = {
    isInspecting: false,
    allInspectFailed: false,
    settled: true,
    visibleCount: 0,
    totalCount: 2,
    alreadyImportedCount: 0,
    isFiltered: false,
  };

  it("stays hidden while inspecting, while the error banner owns the surface, and until settled", () => {
    expect(computeEmptyState({ ...base, isInspecting: true }).show).toBe(false);
    expect(computeEmptyState({ ...base, allInspectFailed: true }).show).toBe(false);
    expect(computeEmptyState({ ...base, settled: false }).show).toBe(false);
    expect(computeEmptyState({ ...base, visibleCount: 1 }).show).toBe(false);
  });

  it("prefers the filter message over the already-imported message", () => {
    expect(computeEmptyState({ ...base, isFiltered: true, alreadyImportedCount: 2 }).title).toBe(
      "当前筛选没有匹配的会话。",
    );
  });

  it("reports already-imported only when every session is imported", () => {
    expect(computeEmptyState({ ...base, alreadyImportedCount: 2 }).title).toBe(
      "所选会话都已经导入过。",
    );
    expect(computeEmptyState({ ...base, alreadyImportedCount: 1 }).title).toBe(
      "没有可导入的会话。",
    );
  });
});

describe("summarize", () => {
  it("counts run outcomes and accumulates insert/duplicate totals", () => {
    expect(
      summarize([
        row({ clientRef: "c1", status: "imported", selected: true, inserted: 4, duplicates: 0 }),
        row({ clientRef: "c2", status: "failed", selected: true }),
        row({ clientRef: "c3", status: "imported", inserted: 0, duplicates: 4 }),
      ]),
    ).toEqual({ selected: 2, imported: 2, failed: 1, inserted: 4, duplicates: 4 });
  });
});
