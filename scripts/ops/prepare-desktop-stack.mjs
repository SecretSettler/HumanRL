import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

const root = resolve(import.meta.dirname, "../..");
const outputDirectory = resolve(root, "apps/desktop/src-tauri/resources");
const output = resolve(outputDirectory, "intenttrace-stack.tar.gz");
const includes = [
  ".node-version",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.base.json",
  "docker-compose.yml",
  "infra",
  "apps/api",
  "apps/web",
  "apps/worker",
  "apps/collector",
  "packages",
  "scripts/checks/check-docs.mjs",
  "scripts/checks/check-compose.mjs",
  "scripts/ops/docker-stack.mjs",
];
await mkdir(outputDirectory, { recursive: true });
await rm(output, { force: true });
await new Promise((resolvePromise, reject) => {
  const child = spawn(
    "tar",
    [
      "--exclude=node_modules",
      "--exclude=dist",
      "--exclude=.next",
      "--exclude=.turbo",
      "--exclude=target",
      "-czf",
      output,
      ...includes,
    ],
    { cwd: root, stdio: "inherit" },
  );
  child.once("error", reject);
  child.once("exit", (code) =>
    code === 0 ? resolvePromise() : reject(new Error(`tar exited ${code}`)),
  );
});
process.stdout.write(`Prepared desktop stack resource: ${output}\n`);
