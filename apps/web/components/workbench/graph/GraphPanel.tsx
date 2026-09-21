"use client";

import {
  Background,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import { ElkIncrementalLayout, type GraphLayoutEngine } from "@intenttrace/graph-layout";
import ElkApi from "elkjs/lib/elk-api.js";
import { useEffect, useMemo, useRef } from "react";

import { agentColor, laneOrderFor, UNASSIGNED_LANE } from "@/lib/workbench/agent-colors";
import { failureVisibleNodeIds } from "@/lib/workbench/derive";
import { useWorkbenchStore } from "@/lib/workbench/store";

import { GhostNodeCard, type GhostNodeCardData } from "./GhostNodeCard";
import { GraphLegend } from "./GraphLegend";
import { GraphToolbar } from "./GraphToolbar";
import { LaneHeaderNode, type LaneHeaderNodeData } from "./LaneHeaderNode";
import { SemanticNodeCard, type SemanticNodeCardData } from "./SemanticNodeCard";
import { WorkbenchEdge, type WorkbenchEdgeData } from "./WorkbenchEdge";

const nodeTypes = { semantic: SemanticNodeCard, ghost: GhostNodeCard, lane: LaneHeaderNode };
const edgeTypes = { workbench: WorkbenchEdge };

const NODE_WIDTH = 246;
const NODE_HEIGHT = 140;
const LANE_GAP = 60;
const LANE_HEADER_OFFSET = 64;

let layoutEngine: GraphLayoutEngine | null = null;
function getLayoutEngine(): GraphLayoutEngine {
  layoutEngine ??= new ElkIncrementalLayout(
    new ElkApi({
      workerFactory: () => new Worker(new URL("elkjs/lib/elk-worker.min.js", import.meta.url)),
    }),
  );
  return layoutEngine;
}

function GraphCanvas() {
  const graph = useWorkbenchStore((state) => state.graph);
  const snapshot = useWorkbenchStore((state) => state.snapshot);
  const selectedNodeId = useWorkbenchStore((state) => state.selectedNodeId);
  const layoutPositions = useWorkbenchStore((state) => state.layoutPositions);
  const filters = useWorkbenchStore((state) => state.filters);
  const pendingChunks = useWorkbenchStore((state) => state.pendingChunks);
  const store = useWorkbenchStore;
  const { fitView } = useReactFlow();
  const fittedRef = useRef(false);

  useEffect(() => {
    if (Object.keys(layoutPositions).length === 0) {
      fittedRef.current = false;
      return;
    }
    if (fittedRef.current) return;
    fittedRef.current = true;
    // Keep a legible floor: a fully zoomed-out map of a wide trace is unreadable,
    // so stop at half scale and let the operator pan or use the zoom presets.
    requestAnimationFrame(() => void fitView({ padding: 0.12, minZoom: 0.5, duration: 200 }));
  }, [fitView, layoutPositions]);

  const laneOrder = useMemo(
    () =>
      graph
        ? laneOrderFor(
            (snapshot?.agents ?? []).map((lane) => lane.agentId),
            graph.nodes.map((node) => node.primaryAgentId),
          )
        : [],
    [graph, snapshot],
  );

  useEffect(() => {
    if (!graph || graph.nodes.length === 0) return;
    let cancelled = false;
    const previousPositions = store.getState().layoutPositions;
    getLayoutEngine()
      .layout(
        graph.nodes.map((node) => ({
          id: node.logicalNodeId,
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          lane: node.primaryAgentId ?? UNASSIGNED_LANE,
          ...(node.layout ? { pinnedPosition: node.layout } : {}),
          ...(previousPositions[node.logicalNodeId]
            ? { previousPosition: previousPositions[node.logicalNodeId], unchanged: true }
            : {}),
        })),
        graph.edges
          .filter((edge) => !edge.retired)
          .map((edge) => ({
            id: edge.logicalEdgeId,
            source: edge.sourceNodeId,
            target: edge.targetNodeId,
          })),
        { lanes: { laneOrder, laneGap: LANE_GAP, rowGap: 36 } },
      )
      .then((positioned) => {
        if (cancelled) return;
        store
          .getState()
          .setLayoutPositions(
            Object.fromEntries(positioned.map((node) => [node.id, { x: node.x, y: node.y }])),
          );
      })
      .catch(() => {
        /* layout failure keeps previous or fallback positions */
      });
    return () => {
      cancelled = true;
    };
  }, [graph, laneOrder, store]);

  const failureVisible = useMemo(
    () => (filters.failuresOnly && graph ? failureVisibleNodeIds(graph.nodes) : null),
    [filters.failuresOnly, graph],
  );

  const flowNodes: Node[] = useMemo(() => {
    const semantic: Node[] = (graph?.nodes ?? []).map((node) => {
      const dimmed = failureVisible ? !failureVisible.has(node.logicalNodeId) : filters.dimSemantic;
      const data: SemanticNodeCardData = {
        node,
        selected: node.logicalNodeId === selectedNodeId,
        dimmed,
      };
      const position = node.layout ?? layoutPositions[node.logicalNodeId] ?? null;
      return {
        id: node.logicalNodeId,
        type: "semantic",
        // Nodes stay hidden until ELK returns a position — no jumping grid fallback.
        position: position ?? { x: 0, y: 0 },
        hidden: position === null,
        data,
      };
    });
    const visible = semantic.filter((node) => !node.hidden);
    const maxY = visible.reduce((max, node) => Math.max(max, node.position.y), 0);
    const minY = visible.reduce(
      (min, node) => Math.min(min, node.position.y),
      visible.length > 0 ? Infinity : 0,
    );
    const ghosts: Node[] = Object.entries(pendingChunks).map(([jobId, chunk], index) => {
      const data: GhostNodeCardData = { jobId, eventWatermark: chunk.eventWatermark };
      return {
        id: `ghost-${jobId}`,
        type: "ghost",
        position: { x: index * (NODE_WIDTH + 40), y: maxY + NODE_HEIGHT + 60 },
        selectable: false,
        data,
      };
    });
    // Lane markers only earn their space when the trace actually has branches.
    const laneNodes: Node[] =
      visible.length === 0 || laneOrder.length < 2
        ? []
        : laneOrder.map((lane, index) => {
            const label =
              lane === UNASSIGNED_LANE
                ? "Unassigned"
                : ((snapshot?.agents ?? []).find((entry) => entry.agentId === lane)?.displayName ??
                  lane);
            const data: LaneHeaderNodeData = {
              label,
              color: agentColor(laneOrder, lane === UNASSIGNED_LANE ? null : lane),
              width: NODE_WIDTH,
              height: maxY - minY + NODE_HEIGHT + LANE_HEADER_OFFSET,
            };
            return {
              id: `lane-${lane}`,
              type: "lane",
              position: { x: index * (NODE_WIDTH + LANE_GAP), y: minY - LANE_HEADER_OFFSET },
              selectable: false,
              draggable: false,
              focusable: false,
              zIndex: -1,
              data,
            };
          });
    return [...laneNodes, ...semantic, ...ghosts];
  }, [
    failureVisible,
    filters.dimSemantic,
    graph,
    laneOrder,
    layoutPositions,
    pendingChunks,
    selectedNodeId,
    snapshot,
  ]);

  const flowEdges: Edge[] = useMemo(
    () =>
      (graph?.edges ?? [])
        .filter((edge) => !edge.retired)
        .map((edge) => {
          const data: WorkbenchEdgeData = { kind: edge.kind };
          return {
            id: edge.logicalEdgeId,
            source: edge.sourceNodeId,
            target: edge.targetNodeId,
            type: "workbench",
            data,
          };
        }),
    [graph],
  );

  return (
    <ReactFlow
      colorMode="dark"
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      onNodeClick={(_, node) => {
        if (node.type === "semantic") store.getState().selectNode(node.id);
      }}
      nodesDraggable={false}
      minZoom={0.2}
      maxZoom={2}
    >
      <Background gap={26} size={1} color="rgba(255,255,255,0.06)" />
      <Controls />
      <Panel position="top-left" className="!m-2.5 w-[calc(100%-20px)]">
        <GraphToolbar />
      </Panel>
      <Panel position="bottom-left" className="!m-2.5 !mb-9">
        <GraphLegend />
      </Panel>
    </ReactFlow>
  );
}

export function GraphPanel() {
  const graph = useWorkbenchStore((state) => state.graph);
  return (
    <>
      <div className="panel-heading">
        <h2>Intent Graph</h2>
        <span>
          {graph?.revision
            ? `${graph.revision.branchKind} r${graph.revision.eventWatermark}${graph.revision.stale ? " · stale" : ""}`
            : "pending"}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <ReactFlowProvider>
          <GraphCanvas />
        </ReactFlowProvider>
      </div>
    </>
  );
}
