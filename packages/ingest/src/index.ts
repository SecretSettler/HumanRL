import { createHash } from "node:crypto";

export type IdempotencyDecision =
  | { action: "insert" }
  | { action: "duplicate"; existingId: string }
  | { action: "conflict"; existingId: string; code: "integrity_conflict" };

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

export function payloadHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function decideIdempotency(
  incomingHash: string,
  existing: { id: string; payloadHash: string } | null,
): IdempotencyDecision {
  if (!existing) return { action: "insert" };
  if (existing.payloadHash === incomingHash)
    return { action: "duplicate", existingId: existing.id };
  return { action: "conflict", existingId: existing.id, code: "integrity_conflict" };
}
