import { expect, test } from "@playwright/test";

const traceIdA = "aaaaaaaa-1111-4111-8111-111111111111";
const traceIdB = "bbbbbbbb-2222-4222-8222-222222222222";

const codexSession = [
  '{"type":"session_meta","version":"codex-jsonl-v1","timestamp":"2026-08-01T00:00:00.000Z","payload":{"id":"codex-a","agent_id":"orchestrator"}}',
  '{"type":"event_msg","version":"codex-jsonl-v1","timestamp":"2026-08-01T00:00:01.000Z","payload":{"type":"user_message","message":"Fix the failing build"}}',
  "",
].join("\n");

const claudeSession = [
  '{"type":"user","version":"claude-jsonl-v1","uuid":"m1","sessionId":"claude-a","timestamp":"2026-08-01T00:00:00.000Z","message":{"role":"user","content":"Explain the crash"}}',
  "",
].join("\n");

const candidateIdA = "a".repeat(24);
const candidateIdB = "b".repeat(24);

const candidates = {
  hidden: {
    protocolVersion: 2,
    alreadyImportedCount: 0,
    candidates: [
      {
        clientRef: "c1",
        candidateId: candidateIdA,
        partRefs: ["c1"],
        source: "codex",
        title: "Codex session",
        projectHint: null,
        firstPromptPreview: null,
        lastPromptPreview: null,
        partialHead: false,
        traceId: traceIdA,
        imported: false,
        importedEventCount: null,
        failureCode: null,
        failureMessage: null,
      },
      {
        clientRef: "c2",
        candidateId: candidateIdB,
        partRefs: ["c2"],
        source: "claude",
        title: "Claude session",
        projectHint: null,
        firstPromptPreview: null,
        lastPromptPreview: null,
        partialHead: false,
        traceId: traceIdB,
        imported: false,
        importedEventCount: null,
        failureCode: null,
        failureMessage: null,
      },
    ],
  },
  shown: {
    protocolVersion: 2,
    alreadyImportedCount: 0,
    candidates: [
      {
        clientRef: "c1",
        candidateId: candidateIdA,
        partRefs: ["c1"],
        source: "codex",
        title: "Codex · Fix the failing build",
        projectHint: null,
        firstPromptPreview: "Fix the failing build",
        lastPromptPreview: "Fix the failing build",
        partialHead: false,
        traceId: traceIdA,
        imported: false,
        importedEventCount: null,
        failureCode: null,
        failureMessage: null,
      },
      {
        clientRef: "c2",
        candidateId: candidateIdB,
        partRefs: ["c2"],
        source: "claude",
        title: "Claude · Explain the crash",
        projectHint: null,
        firstPromptPreview: "Explain the crash",
        lastPromptPreview: "Explain the crash",
        partialHead: false,
        traceId: traceIdB,
        imported: false,
        importedEventCount: null,
        failureCode: null,
        failureMessage: null,
      },
    ],
  },
};

function frameCandidateIds(bytes: Buffer | null): string[] {
  if (!bytes || bytes.byteLength < 8 || bytes.toString("ascii", 0, 4) !== "ITB1") return [];
  const manifestLength = bytes.readUInt32BE(4);
  const manifest = JSON.parse(bytes.subarray(8, 8 + manifestLength).toString("utf8")) as {
    candidateIds?: unknown;
  };
  return Array.isArray(manifest.candidateIds)
    ? manifest.candidateIds.filter((id): id is string => typeof id === "string")
    : [];
}

test("imports browser-selected sessions, gating previews and isolating failures", async ({
  page,
}) => {
  let includePreviews = false;
  await page.route("**/api/v1/imports/candidates", async (route) => {
    const body = route.request().postDataJSON() as { includePreviews: boolean };
    includePreviews = body.includePreviews;
    await route.fulfill({ json: includePreviews ? candidates.shown : candidates.hidden });
  });
  await page.route("**/api/v1/imports/sessions", async (route) => {
    const candidateIds = frameCandidateIds(route.request().postDataBuffer());
    if (candidateIds.includes(candidateIdB)) {
      await route.fulfill({
        status: 422,
        contentType: "application/problem+json",
        json: {
          type: "https://intenttrace.local/problems/no_visible_events",
          title: "Request failed",
          status: 422,
          code: "no_visible_events",
          detail: "Session contains no importable visible events",
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        protocolVersion: 2,
        level: "result",
        command: "upload",
        results: [
          {
            candidateId: candidateIdA,
            sessionId: "0123456789abcdef01234567",
            traceId: traceIdA,
            inserted: 3,
            duplicates: 0,
            warnings: 0,
          },
        ],
      },
    });
  });

  await page.goto("/import");
  await expect(page.getByTestId("import-dropzone")).toBeVisible();
  await page.getByTestId("import-file-input").setInputFiles([
    { name: "alpha.jsonl", mimeType: "application/x-ndjson", buffer: Buffer.from(codexSession) },
    { name: "beta.jsonl", mimeType: "application/x-ndjson", buffer: Buffer.from(claudeSession) },
  ]);

  await expect(page.getByTestId("import-row-c1")).toBeVisible();
  await expect(page.getByTestId("import-row-c2")).toBeVisible();
  await expect(page.getByTestId("import-row-c1")).not.toContainText("Fix the failing build");

  await page.getByTestId("import-preview-toggle").click();
  await expect(page.getByTestId("import-row-c1")).toContainText("Fix the failing build");
  await expect(page.getByTestId("import-row-c2")).toContainText("Explain the crash");

  await page.getByTestId("import-run").click();
  await expect(page.getByTestId("import-row-status-c1")).toHaveText("imported");
  await expect(page.getByTestId("import-row-status-c2")).toHaveText("failed");
  await expect(page.getByTestId("import-row-c2")).toContainText("no_visible_events");
  await expect(page.getByTestId("import-summary")).toHaveText(
    "1 imported · 0 duplicates · 1 failed",
  );
  await expect(page.getByTestId("import-retry-failed")).toBeVisible();
  await expect(
    page.getByTestId("import-row-c1").getByRole("link", { name: /View trace/ }),
  ).toHaveAttribute("href", `/traces/${traceIdA}`);
});
