import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { inspectBundleConfig } from "./bundle-preflight.mjs";

const root = resolve(import.meta.dirname, "..");
const tauriRoot = resolve(root, "src-tauri");
const config = JSON.parse(await readFile(resolve(tauriRoot, "tauri.conf.json"), "utf8"));
JSON.parse(await readFile(resolve(tauriRoot, "capabilities/default.json"), "utf8"));

/** Paths in tauri.conf.json resolve relative to the config's own directory. */
async function probeAll(paths) {
  const probes = new Map();
  for (const relativePath of paths) {
    const absolute = resolve(tauriRoot, relativePath);
    try {
      const info = await stat(absolute);
      probes.set(relativePath, {
        exists: info.isFile(),
        bytes: info.isFile() && info.size < 4_194_304 ? await readFile(absolute) : undefined,
      });
    } catch {
      probes.set(relativePath, { exists: false });
    }
  }
  return probes;
}

const bundle = config.bundle ?? {};
const macOS = bundle.macOS ?? {};
const referenced = [
  ...(bundle.resources ?? []),
  ...(bundle.icon ?? []),
  bundle.licenseFile,
  macOS.entitlements,
  macOS.dmg?.background,
].filter((value) => typeof value === "string");
const probes = await probeAll(referenced);

const { errors, warnings } = inspectBundleConfig(
  config,
  (path) => probes.get(path) ?? { exists: false },
);
for (const warning of warnings) process.stdout.write(`warning: ${warning}\n`);
if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`error: ${error}\n`);
  process.stderr.write(`Bundle preflight failed with ${errors.length} error(s).\n`);
  process.exit(1);
}
process.stdout.write(
  `Bundle preflight passed: ${config.productName} ${config.version} (${config.identifier}), targets ${(bundle.targets ?? []).join(", ")}.\n`,
);

async function run(command, args, stdio = "inherit") {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

const cargoAvailable = await new Promise((resolvePromise) => {
  const child = spawn("cargo", ["--version"], { cwd: root, stdio: "ignore" });
  child.once("error", () => resolvePromise(false));
  child.once("exit", (code) => resolvePromise(code === 0));
});
if (!cargoAvailable) {
  process.stdout.write(
    "Tauri JSON and frontend validated; Rust tooling is not installed in this runtime image.\n",
  );
  process.exit(0);
}
await run("cargo", ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--", "--check"]);
await run(
  "cargo",
  [
    "metadata",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--locked",
    "--no-deps",
    "--format-version",
    "1",
  ],
  "ignore",
);
if (process.platform === "darwin") {
  await run("cargo", ["check", "--manifest-path", "src-tauri/Cargo.toml", "--locked"]);
} else {
  process.stdout.write(
    "Tauri Rust parsed and dependency graph locked; native WebKit compilation is macOS-gated.\n",
  );
}
