import {
  ProviderIntentGraphPatchSchema,
  SchemaVersion,
  type ProviderIntentGraphPatch,
} from "@intenttrace/schema";

export * from "./providers.js";
export * from "./provider-registry.js";
export * from "./security.js";

export interface UserIntentInput {
  jobNonce: string;
  baseRevisionId: string;
  requestEventId: string;
  requestText: string;
  locale: string;
}

export interface ChunkSummaryInput {
  jobNonce: string;
  baseRevisionId: string;
  eventSketch: readonly string[];
  allowedEventIds: readonly string[];
  allowedArtifactIds: readonly string[];
  allowedAgentIds: readonly string[];
  allowedNodeIds: readonly string[];
  locale: string;
}

export interface ReconcileInput extends ChunkSummaryInput {
  finalArtifactIds: readonly string[];
}

export interface SummaryProvider {
  readonly id: string;
  readonly egress: "none" | "local" | "cloud";
  extractUserIntent(input: UserIntentInput): Promise<ProviderIntentGraphPatch>;
  summarizeChunk(input: ChunkSummaryInput): Promise<ProviderIntentGraphPatch>;
  reconcileGraph(input: ReconcileInput): Promise<ProviderIntentGraphPatch>;
  takeUsage?(): ProviderUsage | null;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export class FoundationMockSummaryProvider implements SummaryProvider {
  readonly id = "deterministic-mock-v1";
  readonly egress = "none" as const;

  async extractUserIntent(input: UserIntentInput): Promise<ProviderIntentGraphPatch> {
    return ProviderIntentGraphPatchSchema.parse({
      schemaVersion: SchemaVersion,
      jobNonce: input.jobNonce,
      baseRevisionId: input.baseRevisionId,
      operations: [
        {
          op: "add_node",
          ref: "tmp:1",
          node: {
            kind: "request",
            title: clipTitle(input.requestText, "User request"),
            claims: [
              {
                kind: "intent",
                text: input.requestText.slice(0, 480),
                provenance: "stated",
                suggestedConfidence: "high",
                evidenceEventIds: [input.requestEventId],
              },
            ],
          },
        },
      ],
      diagnostics: ["deterministic offline request extraction"],
    });
  }

  async summarizeChunk(input: ChunkSummaryInput): Promise<ProviderIntentGraphPatch> {
    const events = input.eventSketch
      .map((value) => parseSketch(value))
      .filter((event): event is SketchEvent => event !== null)
      .filter((event) => input.allowedEventIds.includes(event.eventId));
    const completion = events.findLast((event) => event.kind === "trace_complete");
    const selected = selectSemanticEvent(events);
    if (!selected) {
      return this.emptyPatch(input.jobNonce, input.baseRevisionId, "no eligible event in chunk");
    }
    const isFinal = Boolean(completion);
    const isError = selected.status === "error" || selected.contentType === "error";
    const isRequest = selected.kind === "user_message" || selected.contentType === "user_message";
    const evidenceEventIds = [
      selected.eventId,
      ...(completion && completion.eventId !== selected.eventId ? [completion.eventId] : []),
    ];
    const operations: ProviderIntentGraphPatch["operations"] = [
      {
        op: "add_node",
        ref: "tmp:1",
        node: {
          kind: isFinal ? "result" : isError ? "issue" : isRequest ? "request" : "work",
          title: clipTitle(selected.name, isFinal ? "Trace result" : "Observed work"),
          claims: [
            {
              kind: isFinal ? "outcome" : isRequest ? "intent" : "action",
              text: selected.name.slice(0, 480),
              provenance: "stated",
              suggestedConfidence: "high",
              evidenceEventIds,
            },
          ],
        },
      },
    ];
    return ProviderIntentGraphPatchSchema.parse({
      schemaVersion: SchemaVersion,
      jobNonce: input.jobNonce,
      baseRevisionId: input.baseRevisionId,
      operations,
      diagnostics: ["deterministic offline chunk summarization"],
    });
  }

  async reconcileGraph(input: ReconcileInput): Promise<ProviderIntentGraphPatch> {
    return this.summarizeChunk(input);
  }

  private emptyPatch(
    jobNonce: string,
    baseRevisionId: string,
    diagnostic = "deterministic mock found no semantic delta",
  ): ProviderIntentGraphPatch {
    return ProviderIntentGraphPatchSchema.parse({
      schemaVersion: SchemaVersion,
      jobNonce,
      baseRevisionId,
      operations: [],
      diagnostics: [diagnostic],
    });
  }
}

function clipTitle(value: string, fallback: string): string {
  const normalized = value.replaceAll(/\s+/gu, " ").trim();
  const candidate = normalized.length >= 3 ? normalized : fallback;
  return candidate.slice(0, 80);
}

interface SketchEvent {
  eventId: string;
  kind: string;
  status: string;
  agentId: string;
  name: string;
  contentType: string;
  artifactIds: string[];
}

function parseSketch(value: string | undefined): SketchEvent | null {
  if (!value) return null;
  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      if (
        typeof parsed.eventId !== "string" ||
        typeof parsed.kind !== "string" ||
        typeof parsed.status !== "string" ||
        typeof parsed.agentId !== "string" ||
        typeof parsed.name !== "string"
      )
        return null;
      return {
        eventId: parsed.eventId,
        kind: parsed.kind,
        status: parsed.status,
        agentId: parsed.agentId,
        name: parsed.name,
        contentType: typeof parsed.contentType === "string" ? parsed.contentType : "unknown",
        artifactIds: Array.isArray(parsed.artifactIds)
          ? parsed.artifactIds.filter((id): id is string => typeof id === "string")
          : [],
      };
    } catch {
      return null;
    }
  }
  const [eventId, kind, status, agentId, ...name] = value.split("|");
  if (!eventId || !kind || !status || !agentId || name.length === 0) return null;
  return {
    eventId,
    kind,
    status,
    agentId,
    name: name.join("|"),
    contentType: "unknown",
    artifactIds: [],
  };
}

function selectSemanticEvent(events: readonly SketchEvent[]): SketchEvent | null {
  let selected: SketchEvent | null = null;
  let selectedScore = -1;
  for (const event of events) {
    if (event.kind === "trace_complete") continue;
    const score = semanticScore(event);
    if (score >= selectedScore) {
      selected = event;
      selectedScore = score;
    }
  }
  return selected ?? events.at(-1) ?? null;
}

function semanticScore(event: SketchEvent): number {
  if (event.status === "error" || event.contentType === "error") return 100;
  if (event.kind === "user_message" || event.contentType === "user_message") return 90;
  if (event.kind === "assistant_message" || event.contentType === "assistant_message") return 80;
  if (event.kind === "tool_result" || event.contentType === "tool_result") return 70;
  if (event.kind === "tool_call" || event.contentType === "tool_call") return 60;
  if (event.contentType === "agent_activity") return 50;
  if (["telemetry", "metadata", "context"].includes(event.contentType)) return 5;
  return 30;
}
