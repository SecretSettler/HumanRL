import { z } from "zod";

import { ImportSourceKindSchema } from "@intenttrace/schema";

import { normalizeAdapterInput, type AdapterPart } from "@intenttrace/adapters";

export const SESSION_BUNDLE_MEDIA_TYPE = "application/vnd.intenttrace.session-bundle";
export const SESSION_BUNDLE_MAX_MANIFEST_BYTES = 1024 * 1024;

const ManifestPartSchema = z
  .object({
    clientRef: z.string().min(1).max(64),
    path: z.string().min(1).max(1024),
    offset: z.number().int().nonnegative(),
    byteLength: z.number().int().positive(),
    modifiedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const ManifestSchema = z
  .object({
    protocolVersion: z.literal(1),
    source: z.union([z.literal("auto"), ImportSourceKindSchema]),
    candidateIds: z.array(z.string().regex(/^[a-f0-9]{24}$/u)).max(50),
    parts: z.array(ManifestPartSchema).min(1).max(5_000),
  })
  .strict();

export interface SessionBundlePart extends AdapterPart {
  clientRef: string;
  modifiedAt: string;
}

export interface SessionBundleFrame {
  source: z.infer<typeof ManifestSchema>["source"];
  candidateIds: string[];
  parts: SessionBundlePart[];
}

export function parseSessionBundleFrame(bytes: Buffer): SessionBundleFrame {
  if (bytes.byteLength < 8 || bytes.toString("ascii", 0, 4) !== "ITB1") {
    throw new Error("Invalid session bundle magic");
  }
  const manifestLength = bytes.readUInt32BE(4);
  if (manifestLength > SESSION_BUNDLE_MAX_MANIFEST_BYTES) {
    throw new Error("Session bundle manifest exceeds 1 MiB");
  }
  if (manifestLength === 0 || 8 + manifestLength > bytes.byteLength) {
    throw new Error("Invalid session bundle manifest length");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(8, 8 + manifestLength)),
    ) as unknown;
  } catch {
    throw new Error("Invalid UTF-8 JSON session bundle manifest");
  }
  const manifest = ManifestSchema.parse(decoded);
  const refs = new Set<string>();
  for (const [index, part] of manifest.parts.entries()) {
    if (refs.has(part.clientRef))
      throw new Error(`Duplicate session bundle clientRef: ${part.clientRef}`);
    refs.add(part.clientRef);
    if (index > 0 && part.offset <= manifest.parts[index - 1]!.offset) {
      throw new Error("Session bundle parts must be declared in increasing offset order");
    }
  }
  const payload = bytes.subarray(8 + manifestLength);
  const sorted = manifest.parts;
  let expectedOffset = 0;
  for (const part of sorted) {
    if (part.offset !== expectedOffset) {
      throw new Error("Session bundle ranges must exactly cover the payload");
    }
    expectedOffset += part.byteLength;
    if (expectedOffset > payload.byteLength) {
      throw new Error("Session bundle range exceeds the payload");
    }
  }
  if (expectedOffset !== payload.byteLength) {
    throw new Error("Session bundle ranges must exactly cover the payload");
  }
  const views = manifest.parts.map((part) => ({
    clientRef: part.clientRef,
    path: part.path,
    modifiedAt: part.modifiedAt,
    bytes: payload.subarray(part.offset, part.offset + part.byteLength),
  }));
  const normalized = normalizeAdapterInput({ parts: views, sourceIdentity: "frame-validation" });
  const byPath = new Map(
    views.map((part) => [
      normalizeAdapterInput({ parts: [part], sourceIdentity: "path-normalization" }).parts[0]!.path,
      part,
    ]),
  );
  return {
    source: manifest.source,
    candidateIds: [...manifest.candidateIds],
    parts: normalized.parts.map((part) => {
      const metadata = byPath.get(part.path);
      if (!metadata) throw new Error("Missing session bundle part metadata");
      return { ...part, clientRef: metadata.clientRef, modifiedAt: metadata.modifiedAt };
    }),
  };
}
