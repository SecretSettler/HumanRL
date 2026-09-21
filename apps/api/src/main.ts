import { loadRuntimeConfig } from "@intenttrace/config";
import { IntentTraceRepository } from "@intenttrace/db";
import { FileArtifactStore } from "@intenttrace/storage";
import postgres from "postgres";

import { buildApp, type ReadinessResult } from "./app.js";

const config = loadRuntimeConfig();
const sql = postgres(config.DATABASE_URL, { max: 2, idle_timeout: 20 });
const repository = new IntentTraceRepository(sql);
const artifactStore = new FileArtifactStore(config.ARTIFACT_ROOT);

async function readiness(): Promise<ReadinessResult> {
  const postgresStatus: ReadinessResult["postgres"] = await sql`select 1`
    .then(() => "ok" as const)
    .catch(() => "error" as const);
  return { ready: postgresStatus === "ok", postgres: postgresStatus };
}

const app = buildApp({
  logger: {
    level: config.LOG_LEVEL,
    redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
  },
  readiness,
  version: config.APP_VERSION,
  gitCommit: config.GIT_COMMIT,
  services: { repository, artifactStore },
  uploadMaxBytes: config.IMPORT_UPLOAD_MAX_BYTES,
});

app.addHook("onClose", async () => {
  await sql.end();
});

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch (error) {
  app.log.fatal({ err: error }, "IntentTrace API failed to start");
  process.exitCode = 1;
}
