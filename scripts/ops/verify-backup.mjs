import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const requestedSource = process.argv.slice(2).find((argument) => argument !== "--");
const source = requestedSource ? resolve(requestedSource) : null;
if (!source) throw new Error("Usage: pnpm backup:verify -- <backup-directory>");
const manifest = JSON.parse(await readFile(resolve(source, "manifest.json"), "utf8"));
for (const [name, expected] of Object.entries(manifest.files)) {
  const bytes = await readFile(resolve(source, name));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected.sha256 || bytes.byteLength !== expected.byteLength)
    throw new Error(`Backup integrity mismatch: ${name}`);
}
const databaseName = `intenttrace_restore_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const docker = ["compose", "-f", "docker-compose.yml", "exec", "-T", "postgres"];
try {
  execFileSync("docker", [...docker, "createdb", "-U", "intenttrace", databaseName], {
    stdio: "pipe",
  });
  const dump = await readFile(resolve(source, "database.dump"));
  const restore = spawnSync(
    "docker",
    [
      ...docker,
      "pg_restore",
      "-U",
      "intenttrace",
      "-d",
      databaseName,
      "--no-owner",
      "--no-privileges",
    ],
    { input: dump, maxBuffer: 1024 * 1024 * 1024 },
  );
  if (restore.status !== 0) throw new Error(`pg_restore failed: ${restore.stderr.toString()}`);
  const counts = execFileSync(
    "docker",
    [
      ...docker,
      "psql",
      "-U",
      "intenttrace",
      "-d",
      databaseName,
      "-Atc",
      "select count(*) from traces; select count(*) from raw_events; select count(*) from semantic_revisions;",
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n");
  execFileSync("tar", ["-tzf", resolve(source, "artifacts.tar.gz")], { stdio: "ignore" });
  process.stdout.write(
    `Backup restore drill passed in isolated database ${databaseName}: traces=${counts[0]}, raw_events=${counts[1]}, revisions=${counts[2]}\n`,
  );
} finally {
  execFileSync("docker", [...docker, "dropdb", "-U", "intenttrace", "--if-exists", databaseName], {
    stdio: "ignore",
  });
}
