import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { UuidSchema } from "@intenttrace/schema";

export interface ArtifactMetadata {
  traceId: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
}

export interface PutArtifactInput {
  traceId: string;
  bytes: Uint8Array;
  mediaType: string;
}

export interface ArtifactStore {
  put(input: PutArtifactInput): Promise<ArtifactMetadata>;
  stat(traceId: string, sha256: string): Promise<ArtifactMetadata | null>;
  getRange(traceId: string, sha256: string, offset: number, length: number): Promise<Uint8Array>;
  deleteTrace(traceId: string): Promise<void>;
}

function validateTraceId(traceId: string): string {
  return UuidSchema.parse(traceId);
}

function validateHash(sha256: string): string {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error("Invalid SHA-256");
  return sha256;
}

export class FileArtifactStore implements ArtifactStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async put(input: PutArtifactInput): Promise<ArtifactMetadata> {
    const traceId = validateTraceId(input.traceId);
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const path = this.#path(traceId, sha256);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, input.bytes, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, path).catch(async (error: unknown) => {
      await rm(temporaryPath, { force: true });
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const metadata = {
      traceId,
      sha256,
      byteLength: input.bytes.byteLength,
      mediaType: input.mediaType,
    };
    await writeFile(`${path}.json`, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
    return metadata;
  }

  async stat(traceId: string, sha256: string): Promise<ArtifactMetadata | null> {
    const path = this.#path(validateTraceId(traceId), validateHash(sha256));
    try {
      return JSON.parse(await readFile(`${path}.json`, "utf8")) as ArtifactMetadata;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async getRange(
    traceId: string,
    sha256: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0
    ) {
      throw new RangeError("Invalid artifact range");
    }
    const path = this.#path(validateTraceId(traceId), validateHash(sha256));
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      const available = Math.max(0, Math.min(length, info.size - offset));
      const buffer = Buffer.alloc(available);
      await file.read(buffer, 0, available, offset);
      return buffer;
    } finally {
      await file.close();
    }
  }

  async deleteTrace(traceId: string): Promise<void> {
    await rm(join(this.#root, validateTraceId(traceId)), { recursive: true, force: true });
  }

  #path(traceId: string, sha256: string): string {
    const safeHash = validateHash(sha256);
    return join(this.#root, traceId, safeHash.slice(0, 2), safeHash);
  }
}
