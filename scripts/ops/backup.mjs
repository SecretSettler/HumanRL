import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const requestedDestination = process.argv.slice(2).find((argument) => argument !== "--");
const destination = resolve(
  requestedDestination ??
    `.intenttrace/backups/${new Date().toISOString().replaceAll(/[:.]/gu, "-")}`,
);
await mkdir(destination, { recursive: true, mode: 0o700 });
const compose = ["compose", "-f", "docker-compose.yml", "exec", "-T"];
const database = execFileSync(
  "docker",
  [...compose, "postgres", "pg_dump", "-U", "intenttrace", "-d", "intenttrace", "-Fc"],
  { maxBuffer: 1024 * 1024 * 1024 },
);
const artifacts = execFileSync(
  "docker",
  [...compose, "api", "tar", "-C", "/var/lib/intenttrace/artifacts", "-czf", "-", "."],
  { maxBuffer: 1024 * 1024 * 1024 },
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
await Promise.all([
  writeFile(resolve(destination, "database.dump"), database, { mode: 0o600 }),
  writeFile(resolve(destination, "artifacts.tar.gz"), artifacts, { mode: 0o600 }),
]);
const manifest = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  files: {
    "database.dump": { sha256: hash(database), byteLength: database.byteLength },
    "artifacts.tar.gz": { sha256: hash(artifacts), byteLength: artifacts.byteLength },
  },
};
await writeFile(resolve(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o600,
});
process.stdout.write(`IntentTrace backup created at ${destination}\n`);
