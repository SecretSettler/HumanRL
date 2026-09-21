import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileArtifactStore } from "../src/index.js";

const roots: string[] = [];
const traceId = "019fbbb3-4324-7d43-8f9c-cd489a92cb31";

afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("FileArtifactStore", () => {
  it("stores content by trace and hash and reads bounded ranges", async () => {
    const root = await mkdtemp(join(tmpdir(), "intenttrace-storage-"));
    roots.push(root);
    const store = new FileArtifactStore(root);
    const metadata = await store.put({
      traceId,
      bytes: Buffer.from("evidence"),
      mediaType: "text/plain",
    });
    expect(metadata.byteLength).toBe(8);
    expect(await store.getRange(traceId, metadata.sha256, 1, 3)).toEqual(Buffer.from("vid"));
    expect(await store.stat(traceId, metadata.sha256)).toEqual(metadata);
  });
});
