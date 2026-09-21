import { execFileSync } from "node:child_process";

import { generateAcceptanceFixture } from "../../packages/test-fixtures/src/index.js";

function resolveOrigin(): string {
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
const events = generateAcceptanceFixture(2048);
let inserted = 0;
let duplicates = 0;
for (const event of events) {
  const response = await fetch(`${origin}/api/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  if (!response.ok)
    throw new Error(
      `Demo ingestion failed at ${event.source.sourceEventId}: ${response.status} ${await response.text()}`,
    );
  const result = (await response.json()) as { duplicate: boolean };
  if (result.duplicate) duplicates += 1;
  else inserted += 1;
}
process.stdout.write(
  `Loaded deterministic six-agent demo through ${origin}: ${inserted} inserted, ${duplicates} duplicates.\n`,
);
