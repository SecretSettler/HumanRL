"use client";

import { useMemo, useState } from "react";

import { distinctEvidenceCount, nodeConfidence, nodeProvenance } from "@/lib/workbench/derive";
import { formatCostUsd, formatDurationBetween } from "@/lib/workbench/format";
import { nodeKindMeta, nodeStatusMeta } from "@/lib/workbench/graph-meta";
import { useWorkbenchStore } from "@/lib/workbench/store";
import { artifactUrl, patchNode } from "@/lib/workbench/trace-api";
import type {
  ClaimKind,
  RawTraceEvent,
  SemanticGraphSnapshot,
  SemanticNodeStatus,
} from "@/lib/workbench/types";

import { EditSummaryForm } from "./EditSummaryForm";
import { RawEventDetail } from "./RawEventDetail";
import { KeyValue, Section } from "./Section";

const claimKindLabels: Record<ClaimKind, string> = {
  intent: "Intent",
  action: "Action",
  outcome: "Outcome",
};

const shortId = (id: string) => `${id.slice(0, 8)}…`;

export function InspectorPanel({ traceId }: { traceId: string }) {
  const snapshot = useWorkbenchStore((state) => state.snapshot);
  const graph = useWorkbenchStore((state) => state.graph);
  const selectedNodeId = useWorkbenchStore((state) => state.selectedNodeId);
  const selectedEventId = useWorkbenchStore((state) => state.selectedEventId);
  const playhead = useWorkbenchStore((state) => state.playhead);
  const feedbackDraft = useWorkbenchStore((state) => state.feedbackDraft);
  const setFeedbackDraft = useWorkbenchStore((state) => state.setFeedbackDraft);
  const providerCalls = useWorkbenchStore((state) => state.providerCalls);
  const store = useWorkbenchStore;

  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const eventById = useMemo(() => {
    const map = new Map<string, RawTraceEvent>();
    for (const event of snapshot?.raw.events ?? []) {
      if (Number(event.ingestSeq) <= playhead) map.set(event.id, event);
    }
    return map;
  }, [playhead, snapshot]);

  const node = graph?.nodes.find((entry) => entry.logicalNodeId === selectedNodeId) ?? null;
  const selectedEvent = selectedEventId ? (eventById.get(selectedEventId) ?? null) : null;

  const evidenceEvents = useMemo(() => {
    if (!node) return [];
    const ids = [...new Set(node.claims.flatMap((claim) => claim.evidenceEventIds))];
    return ids.map((id) => ({ id, event: eventById.get(id) ?? null }));
  }, [eventById, node]);

  const traceCost = formatCostUsd((providerCalls ?? []).map((call) => call.costUsd));
  const traceTokens = (providerCalls ?? []).reduce(
    (sum, call) => sum + Number(call.inputTokens ?? 0) + Number(call.outputTokens ?? 0),
    0,
  );

  const applyEdit = async (edit: {
    title?: string;
    status?: SemanticNodeStatus;
    pinned?: boolean;
    feedback?: string;
  }) => {
    if (!node || !graph) return;
    setEditError(null);
    const response = await patchNode(traceId, node.logicalNodeId, {
      baseRevisionId: graph.revision.id,
      ...edit,
    });
    if (response.status === 409) {
      setEditError("Revision 已前进：请刷新后再编辑。");
      return;
    }
    if (!response.ok) {
      setEditError(`human edit ${response.status}`);
      return;
    }
    store.getState().setGraph((await response.json()) as SemanticGraphSnapshot);
    setEditing(false);
    setFeedbackDraft("");
  };

  if (!node && !selectedEvent) {
    return (
      <div className="p-4">
        <p className="muted m-0 text-body">选择图节点查看确定性 reducer 接受的证据。</p>
      </div>
    );
  }

  const kind = node ? nodeKindMeta[node.kind] : null;
  const status = node ? nodeStatusMeta[node.status] : null;

  return (
    <div className="p-4">
      {node && kind && status ? (
        <>
          <header className="mb-2">
            <p className="m-0 text-micro font-bold uppercase tracking-[0.13em] text-muted-2">
              {kind.label}
            </p>
            <h3 className="m-0 mt-1 text-lead leading-snug">{node.title}</h3>
            <p className="m-0 mt-1 text-micro text-muted-2">
              node {shortId(node.logicalNodeId)} ·{" "}
              {graph ? `${graph.revision.branchKind} r${graph.revision.eventWatermark}` : ""}
            </p>
          </header>
          {editError ? (
            <p
              role="alert"
              className="m-0 mb-2 rounded-lg border border-red/40 px-2 py-1.5 text-meta text-red"
            >
              {editError}
            </p>
          ) : null}
          <Section title="Semantic summary">
            <div className="grid gap-2">
              {node.claims.map((claim, index) => (
                <article key={`${claim.kind}-${index}`} className="claim">
                  <header>
                    <strong className="text-meta">{claimKindLabels[claim.kind]}</strong>
                    <span>
                      {claim.confidence} · {claim.provenance}
                    </span>
                  </header>
                  <p className="m-0 mt-1 text-body">{claim.text}</p>
                </article>
              ))}
            </div>
            {editing ? (
              <div className="mt-2">
                <EditSummaryForm
                  node={node}
                  onSave={(edit) => applyEdit(edit)}
                  onCancel={() => setEditing(false)}
                />
              </div>
            ) : (
              <div className="human-controls mt-2 !mb-0">
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="flex-1 px-2 py-1.5 text-body"
                    onClick={() => setEditing(true)}
                  >
                    Edit summary
                  </button>
                  <button
                    type="button"
                    className="flex-1 px-2 py-1.5 text-body"
                    onClick={() => void applyEdit({ pinned: !node.pinnedByHuman })}
                  >
                    {node.pinnedByHuman ? "Unpin" : "Pin node"}
                  </button>
                </div>
                <label htmlFor="node-feedback" className="text-meta text-muted">
                  Feedback
                </label>
                <textarea
                  id="node-feedback"
                  value={feedbackDraft}
                  maxLength={1000}
                  onChange={(event) => setFeedbackDraft(event.target.value)}
                  className="text-body"
                />
                <button
                  type="button"
                  disabled={!feedbackDraft.trim()}
                  className="px-2 py-1.5 text-body"
                  onClick={() => void applyEdit({ feedback: feedbackDraft.trim() })}
                >
                  Save feedback
                </button>
              </div>
            )}
          </Section>
          <Section title="Provenance">
            <KeyValue
              rows={[
                ["Provenance", nodeProvenance(node.claims)],
                ["Confidence", nodeConfidence(node.claims)],
                ["Status", status.label],
                ["Kind", kind.label],
              ]}
            />
          </Section>
          <Section title="Evidence">
            <div className="grid gap-1.5">
              {evidenceEvents.map(({ id, event }) => (
                <button
                  key={id}
                  type="button"
                  disabled={!event}
                  onClick={() => event && store.getState().selectEvent(id)}
                  className="flex items-center gap-2 rounded-[9px] border border-line bg-[#0d1118] px-2 py-1.5 text-left"
                >
                  <span
                    aria-hidden
                    className="grid size-[25px] flex-none place-items-center rounded-[7px] border border-line text-micro text-muted"
                  >
                    {event?.status === "error" ? "!" : "→"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-meta font-semibold text-ink">
                      #{event?.ingestSeq ?? "outside playhead"} {event?.name ?? id}
                    </span>
                    {event ? (
                      <span className="block text-micro text-muted-2">
                        {event.kind} · {event.agentId ?? "system"}
                      </span>
                    ) : null}
                  </span>
                  {event ? (
                    <time className="flex-none text-micro text-muted-2">
                      {new Date(event.occurredAt).toLocaleTimeString()}
                    </time>
                  ) : null}
                </button>
              ))}
            </div>
            <p className="m-0 mt-2 text-micro text-muted-2">
              {evidenceEvents.filter(({ event }) => event).length} evidence facts visible at this
              watermark
            </p>
          </Section>
          <Section title="Execution">
            <KeyValue
              rows={[
                ["Agent", node.primaryAgentId ?? "—"],
                [
                  "Participants",
                  node.participantAgentIds.length > 0 ? node.participantAgentIds.join(", ") : "—",
                ],
                ["Duration", formatDurationBetween(node.startedAt, node.endedAt)],
                ["Events", String(distinctEvidenceCount(node.claims))],
                ["Trace cost", providerCalls === null ? "—" : (traceCost ?? "no summary spend")],
                [
                  "Trace tokens",
                  providerCalls === null || traceTokens === 0 ? "—" : String(traceTokens),
                ],
              ]}
            />
            <p className="m-0 mt-1.5 text-micro text-muted-2">
              Cost and tokens are trace-level provider-call totals, not per-node figures.
            </p>
          </Section>
          <Section title="Artifacts & tags">
            {node.artifactIds.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {node.artifactIds.map((artifactId) => (
                  <a
                    key={artifactId}
                    href={artifactUrl(traceId, artifactId, 1_048_576)}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border border-line bg-[#0d1118] px-2 py-1 text-micro text-muted no-underline hover:text-ink"
                  >
                    {shortId(artifactId)}
                  </a>
                ))}
              </div>
            ) : (
              <p className="m-0 text-meta text-muted-2">No artifacts linked to this node.</p>
            )}
          </Section>
          <Section title="Revision">
            <KeyValue
              rows={[
                ["Revision", graph ? shortId(graph.revision.id) : "—"],
                ["Branch", graph?.revision.branchKind ?? "—"],
                ["Watermark", graph ? `r${graph.revision.eventWatermark}` : "—"],
                ["Created", graph ? new Date(graph.revision.createdAt).toLocaleTimeString() : "—"],
                ["Version", shortId(node.id)],
                ["Pinned", node.pinnedByHuman ? "yes" : "no"],
                [
                  "Source job",
                  graph?.revision.sourceJobId ? shortId(graph.revision.sourceJobId) : "—",
                ],
              ]}
            />
          </Section>
        </>
      ) : null}
      {selectedEvent ? <RawEventDetail traceId={traceId} event={selectedEvent} /> : null}
    </div>
  );
}
