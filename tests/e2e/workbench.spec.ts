import { expect, test } from "@playwright/test";

const traceId = "33333333-3333-4333-8333-333333333333";
const revisionId = "44444444-4444-4444-8444-444444444444";
const eventId = "55555555-5555-4555-8555-555555555555";
const nodeId = "66666666-6666-4666-8666-666666666666";
const artifactId = "88888888-8888-4888-8888-888888888888";

test("enters at the trace list and states the local MVP boundary", async ({ page, request }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/traces$/);
  await expect(page.getByRole("heading", { name: "IntentTrace" })).toBeVisible();
  const boundary = page.getByLabel("Deployment boundary");
  await expect(boundary).toContainText("Local MVP");
  await expect(boundary).toContainText("默认无云 egress");
  await expect(boundary).toContainText("single-host / no-auth");
  await expect(boundary).toContainText("服务端不扫描任何目录");
  await expect(boundary.getByRole("link", { name: /历史视觉原型/ })).toBeVisible();
  const health = await request.get("/healthz");
  expect(health.ok()).toBe(true);
  await expect(health.json()).resolves.toMatchObject({ service: "web", status: "ok", gate: 5 });
});

test("links Graph, Gantt, raw evidence, and replay with stable IDs", async ({ page }) => {
  await page.route(`**/api/v1/traces/${traceId}/snapshot**`, async (route) =>
    route.fulfill({
      json: {
        trace: {
          id: traceId,
          title: "Synthetic six-agent trace",
          status: "completed",
          latestIngestSeq: "1",
        },
        raw: {
          events: [
            {
              id: eventId,
              ingestSeq: "1",
              occurredAt: "2026-08-03T00:00:00.000Z",
              kind: "tool_result",
              name: "Escaped <script>alert(1)</script>",
              status: "ok",
              agentId: "backend",
              payloadRef: {
                artifactId,
                sha256: "a".repeat(64),
                byteLength: 92,
              },
              artifactRefs: [artifactId],
              attributes: { contentType: "tool_result" },
            },
          ],
          nextCursor: null,
        },
        agents: [
          {
            agentId: "backend",
            displayName: "Backend",
            eventIds: [eventId],
            startedAt: "2026-08-03T00:00:00.000Z",
            endedAt: "2026-08-03T00:00:00.000Z",
            errorCount: 0,
          },
        ],
        revision: {
          id: revisionId,
          traceId,
          parentRevisionId: null,
          branchKind: "final",
          eventWatermark: "1",
          createdAt: "2026-08-03T00:00:01.000Z",
          sourceJobId: null,
          stale: false,
        },
      },
    }),
  );
  await page.route(`**/api/v1/traces/${traceId}/graph`, async (route) =>
    route.fulfill({
      json: {
        revision: {
          id: revisionId,
          traceId,
          parentRevisionId: null,
          branchKind: "final",
          eventWatermark: "1",
          createdAt: "2026-08-03T00:00:01.000Z",
          sourceJobId: null,
          stale: false,
        },
        nodes: [
          {
            id: "77777777-7777-4777-8777-777777777777",
            logicalNodeId: nodeId,
            traceId,
            title: "Verified result",
            kind: "result",
            status: "completed",
            claims: [
              {
                kind: "outcome",
                text: "The test passed",
                provenance: "stated",
                confidence: "high",
                evidenceEventIds: [eventId],
              },
            ],
            layout: null,
            pinnedByHuman: false,
            primaryParentId: null,
            primaryAgentId: "backend",
            participantAgentIds: ["backend"],
            artifactIds: [],
            startedAt: null,
            endedAt: null,
          },
        ],
        edges: [],
      },
    }),
  );
  await page.route(`**/api/v1/traces/${traceId}/artifacts/${artifactId}**`, async (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        type: "response_item",
        payload: { type: "tool_result", output: "Concrete visible result from the session" },
      }),
    }),
  );
  await page.goto(`/traces/${traceId}`);
  await expect(page.getByRole("heading", { name: "Intent Graph" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent Gantt" })).toBeVisible();
  await page.getByTestId(`node-card-${nodeId}`).click();
  await expect(page.getByLabel("Evidence inspector").getByText("The test passed")).toBeVisible();
  await page
    .getByLabel("Evidence inspector")
    .getByRole("button", { name: /#1 Escaped/ })
    .click();
  await expect(page.getByText("Concrete visible result from the session")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open sanitized source payload" })).toBeVisible();
  await expect(page.locator("main script")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Escaped <script>alert(1)</script>" }),
  ).toBeVisible();
  await page.getByTestId(`gantt-marker-${eventId}`).click();
  await expect(page.getByTestId(`raw-row-${eventId}`)).toHaveClass(/raw-row--selected/);
  await page.route(`**/api/v1/traces/${traceId}/nodes/${nodeId}`, async (route) => {
    const body = route.request().postDataJSON() as { baseRevisionId: string; title?: string };
    expect(body.baseRevisionId).toBe(revisionId);
    expect(body.title).toBe("Edited verified result");
    await route.fulfill({
      json: {
        revision: {
          id: "99999999-9999-4999-8999-999999999999",
          traceId,
          parentRevisionId: revisionId,
          branchKind: "human",
          eventWatermark: "1",
          createdAt: "2026-08-03T00:00:02.000Z",
          sourceJobId: null,
          stale: false,
        },
        nodes: [
          {
            id: "77777777-7777-4777-8777-777777777778",
            logicalNodeId: nodeId,
            traceId,
            title: "Edited verified result",
            kind: "result",
            status: "completed",
            claims: [
              {
                kind: "outcome",
                text: "The test passed",
                provenance: "stated",
                confidence: "high",
                evidenceEventIds: [eventId],
              },
            ],
            layout: null,
            pinnedByHuman: false,
            primaryParentId: null,
            primaryAgentId: "backend",
            participantAgentIds: ["backend"],
            artifactIds: [],
            startedAt: null,
            endedAt: null,
          },
        ],
        edges: [],
      },
    });
  });
  await page.getByRole("button", { name: "Edit summary" }).click();
  await page.getByLabel("Title").fill("Edited verified result");
  await page.getByRole("button", { name: "Save summary" }).click();
  await expect(page.getByTestId(`node-card-${nodeId}`)).toContainText("Edited verified result");
  await page.getByLabel("Known at ingest watermark 1").fill("0");
  await expect(page.getByTestId("raw-count")).toHaveText("0 immutable facts");
  await page.getByTestId("playhead-latest").click();
  await expect(page.getByTestId("raw-count")).toHaveText("1 immutable facts");
  await page.getByTestId("replay-restart").click();
  await expect(page.getByTestId("raw-count")).toHaveText("0 immutable facts");
});

test("renders a deterministic ghost node from semantic_chunk.pending", async ({ page }) => {
  await page.route(`**/api/v1/traces/${traceId}/snapshot**`, async (route) =>
    route.fulfill({
      json: {
        trace: {
          id: traceId,
          title: "Ghost trace",
          status: "active",
          latestIngestSeq: "1",
        },
        raw: { events: [], nextCursor: null },
        agents: [],
        revision: null,
      },
    }),
  );
  await page.route(`**/api/v1/traces/${traceId}/graph`, async (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
  const jobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await page.route(`**/api/v1/traces/${traceId}/stream`, async (route) => {
    const envelope = JSON.stringify({
      schemaVersion: "1.0.0",
      eventId: "1",
      traceId,
      occurredAt: "2026-08-03T00:00:00.000Z",
      revisionId: null,
      type: "semantic_chunk.pending",
      payload: { jobId, eventWatermark: "1" },
    });
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: `id: 1\nevent: semantic_chunk.pending\ndata: ${envelope}\n\n`,
    });
  });
  await page.goto(`/traces/${traceId}`);
  await expect(page.getByTestId(`ghost-node-${jobId}`)).toBeVisible();
  await expect(page.getByText("语义图尚未生成")).toBeVisible();
});

test("keeps keyboard focus visible at 200 percent zoom and reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1024, height: 720 });
  await page.goto("/traces");
  await expect(page.getByRole("heading", { name: "IntentTrace" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => {
    document.body.style.zoom = "2";
  });
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
});
