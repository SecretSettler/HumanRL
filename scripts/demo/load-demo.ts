import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { RawTraceEventInputSchema } from "../../packages/schema/src/index.js";

const fixtureUrl = new URL(
  "../../packages/test-fixtures/fixtures/demo/imo-2025-p1-parallel-solve.jsonl",
  import.meta.url,
);

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
// Whole-file preflight: the recording is validated before the first raw fact is sent.
const events = readFileSync(fixtureUrl, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line, index) => {
    const parsed = RawTraceEventInputSchema.safeParse(JSON.parse(line));
    if (!parsed.success)
      throw new Error(
        `Recorded demo line ${index + 1} is not a canonical event: ${parsed.error.message}`,
      );
    return parsed.data;
  });
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
  `Loaded the recorded nine-lane IMO trace (${events.length} events) through ${origin}: ${inserted} inserted, ${duplicates} duplicates.\n`,
);
