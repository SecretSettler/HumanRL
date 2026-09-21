import type {
  ProviderCallAuditList,
  RawEventPage,
  RawTraceEvent,
  SemanticGraphSnapshot,
  SemanticRevision,
  TraceList,
  TraceSnapshot,
} from "./types";

async function readJson<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) throw new Error(`${label} ${response.status}`);
  return (await response.json()) as T;
}

export async function fetchTraceList(): Promise<TraceList> {
  const response = await fetch("/api/v1/traces", { cache: "no-store" });
  return readJson<TraceList>(response, "traces");
}

export async function fetchSnapshot(traceId: string): Promise<TraceSnapshot> {
  const response = await fetch(`/api/v1/traces/${traceId}/snapshot?limit=1000`, {
    cache: "no-store",
  });
  return readJson<TraceSnapshot>(response, "snapshot");
}

export async function fetchEventsAfter(
  traceId: string,
  after: string | null,
  signal?: AbortSignal,
): Promise<RawTraceEvent[]> {
  const events: RawTraceEvent[] = [];
  let cursor = after;
  do {
    const query = cursor ? `?after=${encodeURIComponent(cursor)}&limit=1000` : "?limit=1000";
    const response = await fetch(`/api/v1/traces/${traceId}/events${query}`, {
      cache: "no-store",
      signal: signal ?? null,
    });
    const page = await readJson<RawEventPage>(response, "raw events");
    events.push(...page.events);
    cursor = page.nextCursor;
  } while (cursor);
  return events;
}

export async function fetchGraph(
  traceId: string,
  revisionId?: string,
): Promise<SemanticGraphSnapshot | null> {
  const query = revisionId ? `?revisionId=${encodeURIComponent(revisionId)}` : "";
  const response = await fetch(`/api/v1/traces/${traceId}/graph${query}`, { cache: "no-store" });
  if (response.status === 204) return null;
  if (!response.ok) return null;
  return (await response.json()) as SemanticGraphSnapshot;
}

export async function fetchRevisions(traceId: string): Promise<SemanticRevision[]> {
  const response = await fetch(`/api/v1/traces/${traceId}/revisions`, { cache: "no-store" });
  const body = await readJson<{ revisions: SemanticRevision[] }>(response, "revisions");
  return body.revisions;
}

export async function fetchProviderCalls(traceId: string): Promise<ProviderCallAuditList> {
  const response = await fetch(`/api/v1/traces/${traceId}/provider-calls`, { cache: "no-store" });
  return readJson<ProviderCallAuditList>(response, "provider calls");
}

export function artifactUrl(traceId: string, artifactId: string, byteLength: number): string {
  const length = Math.min(byteLength, 8_388_608);
  return `/api/v1/traces/${traceId}/artifacts/${artifactId}?offset=0&length=${length}`;
}

export async function patchNode(
  traceId: string,
  logicalNodeId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`/api/v1/traces/${traceId}/nodes/${logicalNodeId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
