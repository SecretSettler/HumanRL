import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { TraceSourceKind } from "@intenttrace/schema";

export interface CollectorCheckpoint {
  schemaVersion: 1;
  source: TraceSourceKind;
  realPath: string;
  fileIdentity: string;
  byteOffset: number;
  prefixHash: string;
  updatedAt: string;
}

function checkpointPath(root: string, source: TraceSourceKind, realPath: string): string {
  const id = createHash("sha256").update(source).update("\0").update(realPath).digest("hex");
  return join(root, `${source}-${id}.json`);
}

export async function loadCheckpoint(
  root: string,
  source: TraceSourceKind,
  realPath: string,
): Promise<CollectorCheckpoint | null> {
  try {
    return JSON.parse(
      await readFile(checkpointPath(root, source, realPath), "utf8"),
    ) as CollectorCheckpoint;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function prefixHash(realPath: string, byteOffset: number): Promise<string> {
  const file = await open(realPath, "r");
  try {
    const length = Math.min(byteOffset, 4096);
    const bytes = Buffer.alloc(length);
    if (length > 0) await file.read(bytes, 0, length, 0);
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    await file.close();
  }
}

export async function saveCheckpoint(
  root: string,
  source: TraceSourceKind,
  realPath: string,
  info: Stats,
): Promise<CollectorCheckpoint> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const checkpoint: CollectorCheckpoint = {
    schemaVersion: 1,
    source,
    realPath,
    fileIdentity: `${info.dev}:${info.ino}`,
    byteOffset: info.size,
    prefixHash: await prefixHash(realPath, info.size),
    updatedAt: new Date().toISOString(),
  };
  const destination = checkpointPath(root, source, realPath);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
  return checkpoint;
}
