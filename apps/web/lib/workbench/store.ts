"use client";

import { create } from "zustand";

import type {
  ConnectionStatus,
  ProviderCallAudit,
  RawTraceEvent,
  SemanticGraphSnapshot,
  TraceSnapshot,
} from "./types";

interface WorkbenchState {
  snapshot: TraceSnapshot | null;
  graph: SemanticGraphSnapshot | null;
  selectedNodeId: string | null;
  selectedEventId: string | null;
  playhead: number;
  connection: ConnectionStatus;
  error: string | null;
  inspectorOpen: boolean;
  layoutPositions: Record<string, { x: number; y: number }>;
  feedbackDraft: string;
  filters: { failuresOnly: boolean; dimSemantic: boolean };
  providerCalls: ProviderCallAudit[] | null;
  pendingChunks: Record<string, { eventWatermark: string }>;
  rawOnlyReason: string | null;
  mode: "live" | "final";
  notice: string | null;
  setSnapshot: (snapshot: TraceSnapshot) => void;
  setGraph: (graph: SemanticGraphSnapshot | null) => void;
  selectNode: (nodeId: string | null) => void;
  selectEvent: (eventId: string | null) => void;
  setPlayhead: (playhead: number) => void;
  setConnection: (connection: ConnectionStatus) => void;
  setError: (error: string | null) => void;
  setInspectorOpen: (open: boolean) => void;
  setLayoutPositions: (positions: Record<string, { x: number; y: number }>) => void;
  setFeedbackDraft: (draft: string) => void;
  setFilters: (filters: Partial<{ failuresOnly: boolean; dimSemantic: boolean }>) => void;
  setProviderCalls: (calls: ProviderCallAudit[] | null) => void;
  appendEvents: (events: readonly RawTraceEvent[]) => void;
  patchTrace: (patch: Partial<TraceSnapshot["trace"]>) => void;
  addPendingChunk: (jobId: string, eventWatermark: string) => void;
  clearPendingChunks: () => void;
  setRawOnlyReason: (reason: string | null) => void;
  setMode: (mode: "live" | "final") => void;
  setNotice: (notice: string | null) => void;
  reset: () => void;
}

const initialState = {
  snapshot: null,
  graph: null,
  selectedNodeId: null,
  selectedEventId: null,
  playhead: 0,
  connection: "connecting" as ConnectionStatus,
  error: null,
  inspectorOpen: false,
  layoutPositions: {},
  feedbackDraft: "",
  filters: { failuresOnly: false, dimSemantic: false },
  providerCalls: null,
  pendingChunks: {},
  rawOnlyReason: null,
  mode: "live" as const,
  notice: null,
};

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  ...initialState,
  setSnapshot: (snapshot) =>
    set((state) => ({
      snapshot,
      playhead: state.playhead === 0 ? Number(snapshot.trace.latestIngestSeq) : state.playhead,
    })),
  setGraph: (graph) => set({ graph }),
  selectNode: (selectedNodeId) => set({ selectedNodeId, inspectorOpen: true }),
  selectEvent: (selectedEventId) => set({ selectedEventId, inspectorOpen: true }),
  setPlayhead: (playhead) => set({ playhead }),
  setConnection: (connection) => set({ connection }),
  setError: (error) => set({ error }),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  setLayoutPositions: (layoutPositions) => set({ layoutPositions }),
  setFeedbackDraft: (feedbackDraft) => set({ feedbackDraft }),
  setFilters: (filters) => set((state) => ({ filters: { ...state.filters, ...filters } })),
  setProviderCalls: (providerCalls) => set({ providerCalls }),
  appendEvents: (incoming) =>
    set((state) => {
      if (!state.snapshot || incoming.length === 0) return state;
      const known = new Set(state.snapshot.raw.events.map((event) => event.id));
      const fresh = incoming.filter((event) => !known.has(event.id));
      if (fresh.length === 0) return state;
      const events = [...state.snapshot.raw.events, ...fresh].sort(
        (a, b) => Number(a.ingestSeq) - Number(b.ingestSeq),
      );
      const agents = state.snapshot.agents.map((lane) => ({
        ...lane,
        eventIds: [...lane.eventIds],
      }));
      for (const event of fresh) {
        const agentId = event.agentId ?? "system";
        let lane = agents.find((entry) => entry.agentId === agentId);
        if (!lane) {
          lane = {
            agentId,
            displayName: agentId,
            eventIds: [],
            startedAt: event.occurredAt,
            endedAt: event.occurredAt,
            errorCount: 0,
          };
          agents.push(lane);
        }
        lane.eventIds.push(event.id);
        if (event.occurredAt < lane.startedAt) lane.startedAt = event.occurredAt;
        if (event.occurredAt > lane.endedAt) lane.endedAt = event.occurredAt;
        if (event.status === "error") lane.errorCount += 1;
      }
      const latest = events.at(-1)?.ingestSeq ?? state.snapshot.trace.latestIngestSeq;
      const wasAtLatest = state.playhead >= Number(state.snapshot.trace.latestIngestSeq);
      return {
        snapshot: {
          ...state.snapshot,
          trace: {
            ...state.snapshot.trace,
            latestIngestSeq: latest,
            eventCount: String(events.length),
          },
          raw: { events, nextCursor: null },
          agents,
        },
        playhead: wasAtLatest ? Number(latest) : state.playhead,
      };
    }),
  patchTrace: (patch) =>
    set((state) =>
      state.snapshot
        ? { snapshot: { ...state.snapshot, trace: { ...state.snapshot.trace, ...patch } } }
        : state,
    ),
  addPendingChunk: (jobId, eventWatermark) =>
    set((state) => ({ pendingChunks: { ...state.pendingChunks, [jobId]: { eventWatermark } } })),
  clearPendingChunks: () => set({ pendingChunks: {} }),
  setRawOnlyReason: (rawOnlyReason) => set({ rawOnlyReason }),
  setMode: (mode) => set({ mode }),
  setNotice: (notice) => set({ notice }),
  reset: () => set(initialState),
}));
