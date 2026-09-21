import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { chromium } from "@playwright/test";

const demoTitle = "IMO 2025 P1 solved by eight parallel agents";

function resolveOrigin() {
  if (process.env.INTENTTRACE_WEB_ORIGIN) return process.env.INTENTTRACE_WEB_ORIGIN;
  const mapping = execFileSync(
    "docker",
    ["compose", "-f", "docker-compose.yml", "port", "web", "3000"],
    { encoding: "utf8" },
  ).trim();
  const port = mapping.split(":").at(-1);
  if (!port || !/^\d+$/u.test(port)) throw new Error(`Unable to parse web port: ${mapping}`);
  return `http://127.0.0.1:${port}`;
}

const origin = resolveOrigin();
const response = await globalThis.fetch(`${origin}/api/v1/traces`);
if (!response.ok) throw new Error(`Unable to list traces: HTTP ${response.status}`);
const payload = await response.json();
const demo = payload.traces.find((trace) => trace.title === demoTitle);
if (!demo) {
  throw new Error(`Demo trace not found. Run \`pnpm demo:load\` against ${origin} first.`);
}

const outputDirectory = path.resolve("docs/assets");
await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 420 },
    // 2x pixel density: README renders these at roughly half their CSS width,
    // so 1x captures lose node-card text to downscaling.
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });

  // Keep README captures limited to the recorded demo trace even when the local stack holds private traces.
  await page.route("**/api/v1/traces", async (route) => {
    await route.fulfill({ json: { traces: [demo], nextCursor: null } });
  });

  await page.goto(`${origin}/traces`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: new RegExp(demoTitle, "u") }).waitFor();
  await page.screenshot({
    path: path.join(outputDirectory, "trace-list.png"),
    animations: "disabled",
  });

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${origin}/traces/${demo.id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Intent Graph" }).waitFor({ timeout: 30_000 });
  const firstNode = page.locator('[data-testid^="node-card-"]').first();
  await firstNode.waitFor({ timeout: 30_000 });
  // Select the node while the graph is still fitted: every card is on screen
  // and therefore clickable. Zooming first leaves the first card outside the
  // viewport, where Playwright never sees it become stable.
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.waitForTimeout(750);
  await firstNode.click();
  await page.getByLabel("Evidence inspector").locator("section").first().waitFor();
  // Then L1 (zoom 0.55) rather than Fit: fitting all 40 nodes lands at zoom
  // 0.25, which renders a 246x123 node card at 62x31 and makes its text
  // unreadable once the README downscales the capture.
  await page.getByRole("button", { name: "L1", exact: true }).click();
  await page.waitForTimeout(750);
  await page.screenshot({
    path: path.join(outputDirectory, "workbench.png"),
    animations: "disabled",
  });
} finally {
  await browser.close();
}

process.stdout.write(`Captured README screenshots of the recorded demo trace from ${origin}.\n`);
