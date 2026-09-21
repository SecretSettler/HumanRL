export type {
  AgentTimelineLane,
  ClaimKind,
  Confidence,
  Provenance,
  ProviderCallAudit,
  ProviderCallAuditList,
  RawEventPage,
  RawTraceEvent,
  SemanticEdgeKind,
  SemanticEdgeVersion,
  SemanticGraphSnapshot,
  SemanticNodeKind,
  SemanticNodeStatus,
  SemanticNodeVersion,
  SemanticRevision,
  TraceList,
  TraceSnapshot,
  TraceSummary,
} from "@intenttrace/schema";

export type ConnectionStatus = "connecting" | "live" | "reconnecting" | "backfilling";

export interface ArtifactDetail {
  eventId: string;
  text: string;
  truncated: boolean;
  error: string | null;
}
