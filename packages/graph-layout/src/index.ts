import type { ELK, ElkNode } from "elkjs";
import ElkModule from "elkjs/lib/elk.bundled.js";

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
  /** Swimlane key (e.g. the primary agent id) used for column assignment. */
  lane?: string;
  pinnedPosition?: { x: number; y: number };
  previousPosition?: { x: number; y: number };
  unchanged?: boolean;
}

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
}

export interface PositionedNode extends LayoutNode {
  x: number;
  y: number;
}

export interface LaneLayoutOptions {
  /** Lane keys in display order; a node whose lane is absent keeps its x. */
  laneOrder: readonly string[];
  /** Horizontal gap between lane columns. */
  laneGap?: number;
  /** Minimum vertical gap between two nodes sharing a lane. */
  rowGap?: number;
}

export interface LayoutOptions {
  lanes?: LaneLayoutOptions;
}

export interface GraphLayoutEngine {
  layout(
    nodes: readonly LayoutNode[],
    edges: readonly LayoutEdge[],
    options?: LayoutOptions,
  ): Promise<readonly PositionedNode[]>;
}

/**
 * Snaps nodes into per-lane columns while keeping the engine's vertical
 * (time) ordering, then pushes same-lane overlaps downward so cards never
 * cover each other. Pinned nodes keep their stored coordinates.
 */
export function applyLaneColumns(
  nodes: readonly PositionedNode[],
  options: LaneLayoutOptions,
): readonly PositionedNode[] {
  const { laneOrder, laneGap = 60, rowGap = 36 } = options;
  if (laneOrder.length === 0) return nodes;
  const columnWidth = Math.max(...nodes.map((node) => node.width), 0) + laneGap;
  const laneIndex = new Map(laneOrder.map((lane, index) => [lane, index] as const));

  const placed = nodes.map((node) => {
    if (node.pinnedPosition) return node;
    const index = node.lane === undefined ? undefined : laneIndex.get(node.lane);
    return index === undefined ? node : { ...node, x: index * columnWidth };
  });

  const byLane = new Map<number, PositionedNode[]>();
  for (const node of placed) {
    if (node.pinnedPosition) continue;
    const index = node.lane === undefined ? undefined : laneIndex.get(node.lane);
    if (index === undefined) continue;
    const bucket = byLane.get(index);
    if (bucket) bucket.push(node);
    else byLane.set(index, [node]);
  }

  const resolved = new Map<string, PositionedNode>();
  for (const bucket of byLane.values()) {
    const ordered = [...bucket].sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));
    let cursor = Number.NEGATIVE_INFINITY;
    for (const node of ordered) {
      const y = Math.max(node.y, cursor);
      resolved.set(node.id, { ...node, y });
      cursor = y + node.height + rowGap;
    }
  }
  return placed.map((node) => resolved.get(node.id) ?? node);
}

export class ElkIncrementalLayout implements GraphLayoutEngine {
  private readonly elk: ELK;

  /**
   * Accepts a pre-configured ELK instance (e.g. elk-api with a real web
   * worker); defaults to the bundled synchronous engine.
   */
  constructor(elk?: ELK) {
    this.elk = elk ?? new (ElkModule as unknown as { new (): ELK })();
  }

  async layout(
    nodes: readonly LayoutNode[],
    edges: readonly LayoutEdge[],
    options?: LayoutOptions,
  ): Promise<readonly PositionedNode[]> {
    if (nodes.length === 0) return [];
    const graph = await this.elk.layout({
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "DOWN",
        "elk.spacing.nodeNode": "44",
        "elk.layered.spacing.nodeNodeBetweenLayers": "72",
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      },
      children: nodes.map((node) => ({ id: node.id, width: node.width, height: node.height })),
      edges: edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
    });
    const positions = new Map<string, { x: number; y: number }>(
      (graph.children ?? []).map(
        (node: ElkNode) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }] as const,
      ),
    );
    const positioned = nodes.map((node) => {
      const computed = positions.get(node.id) ?? { x: 0, y: 0 };
      const stable =
        node.pinnedPosition ?? (node.unchanged ? node.previousPosition : undefined) ?? computed;
      return { ...node, x: stable.x, y: stable.y };
    });
    return options?.lanes ? applyLaneColumns(positioned, options.lanes) : positioned;
  }
}
