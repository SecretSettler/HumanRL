import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

await import("./check.mjs");
const output = resolve(import.meta.dirname, "../dist");
await mkdir(output, { recursive: true });
await writeFile(
  resolve(output, "desktop-check.json"),
  `${JSON.stringify({ checked: true, nativeBundle: process.platform === "darwin" })}\n`,
);
