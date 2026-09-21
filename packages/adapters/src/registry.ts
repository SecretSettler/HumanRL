import type { TraceSourceKind } from "@intenttrace/schema";
import { ClaudeSessionAdapter } from "./claude.js";
import { CodexSessionAdapter } from "./codex.js";
import { GrokSessionAdapter } from "./grok.js";
import { CanonicalJsonlAdapter } from "./jsonl.js";
import { OmpSessionAdapter } from "./omp.js";
import { OpenCodeSessionAdapter } from "./opencode.js";
import { OtlpHttpJsonAdapter } from "./otlp.js";
import { normalizeAdapterInput, type AdapterInput, type TraceAdapter } from "./types.js";

export { aggregateTopologyCapabilities, lookupTopologyCapability } from "./topology.js";

export function createAdapter(source: TraceSourceKind): TraceAdapter {
  switch (source) {
    case "jsonl":
      return new CanonicalJsonlAdapter();
    case "otlp":
      return new OtlpHttpJsonAdapter();
    case "codex":
      return new CodexSessionAdapter();
    case "claude":
      return new ClaudeSessionAdapter();
    case "opencode":
      return new OpenCodeSessionAdapter();
    case "omp":
      return new OmpSessionAdapter();
    case "grok":
      return new GrokSessionAdapter();
    default:
      throw new Error(`No built-in adapter for ${source}`);
  }
}

export const adapterManifests = (
  ["jsonl", "otlp", "codex", "claude", "opencode", "omp", "grok"] as const
).map((source) => createAdapter(source).manifest);
const detectionOrder = ["jsonl", "otlp", "codex", "claude", "opencode", "omp", "grok"] as const;

export async function detectSourceKind(input: AdapterInput): Promise<TraceSourceKind | null> {
  const normalized = normalizeAdapterInput(input);
  for (const source of detectionOrder)
    if (await createAdapter(source).sniff(normalized)) return source;
  return null;
}
