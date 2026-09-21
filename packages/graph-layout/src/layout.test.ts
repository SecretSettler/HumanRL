import { describe, expect, it } from "vitest";

import { applyLaneColumns, ElkIncrementalLayout, type PositionedNode } from "./index.js";

describe("ELK incremental layout", () => {
  it("preserves pinned and explicitly unchanged node positions", async () => {
    const result = await new ElkIncrementalLayout().layout(
      [
        { id: "a", width: 100, height: 60, pinnedPosition: { x: 12, y: 18 } },
        { id: "b", width: 100, height: 60, unchanged: true, previousPosition: { x: 220, y: 40 } },
        { id: "c", width: 100, height: 60 },
      ],
      [
        { id: "e1", source: "a", target: "b" },
        { id: "e2", source: "b", target: "c" },
      ],
    );
    expect(result[0]).toMatchObject({ x: 12, y: 18 });
    expect(result[1]).toMatchObject({ x: 220, y: 40 });
    expect(Number.isFinite(result[2]?.x)).toBe(true);
  });

  it("flows top-down so vertical position tracks time order", async () => {
    const result = await new ElkIncrementalLayout().layout(
      [
        { id: "a", width: 246, height: 128 },
        { id: "b", width: 246, height: 128 },
      ],
      [{ id: "e1", source: "a", target: "b" }],
    );
    const [a, b] = result;
    expect(b!.y).toBeGreaterThan(a!.y);
  });
});

describe("applyLaneColumns", () => {
  const node = (
    id: string,
    lane: string | undefined,
    x: number,
    y: number,
    extra: Partial<PositionedNode> = {},
  ): PositionedNode => ({ id, width: 246, height: 128, x, y, ...(lane ? { lane } : {}), ...extra });

  it("snaps each lane to its own column in declared order", () => {
    const result = applyLaneColumns(
      [node("a", "alpha", 0, 0), node("b", "beta", 0, 200), node("c", "gamma", 0, 400)],
      { laneOrder: ["alpha", "beta", "gamma"], laneGap: 54 },
    );
    expect(result.map((entry) => entry.x)).toEqual([0, 300, 600]);
  });

  it("pushes same-lane overlaps downward while keeping time order", () => {
    const result = applyLaneColumns([node("late", "alpha", 0, 40), node("early", "alpha", 0, 0)], {
      laneOrder: ["alpha"],
      rowGap: 20,
    });
    const early = result.find((entry) => entry.id === "early")!;
    const late = result.find((entry) => entry.id === "late")!;
    expect(early.y).toBe(0);
    expect(late.y).toBe(148);
    expect(late.y - early.y).toBeGreaterThanOrEqual(early.height);
  });

  it("keeps pinned nodes and unknown lanes exactly where they were", () => {
    const result = applyLaneColumns(
      [
        node("pinned", "beta", 7, 9, { pinnedPosition: { x: 7, y: 9 } }),
        node("orphan", "unknown-agent", 33, 44),
        node("none", undefined, 55, 66),
      ],
      { laneOrder: ["alpha", "beta"] },
    );
    expect(result[0]).toMatchObject({ x: 7, y: 9 });
    expect(result[1]).toMatchObject({ x: 33, y: 44 });
    expect(result[2]).toMatchObject({ x: 55, y: 66 });
  });

  it("is a no-op without lanes", () => {
    const input = [node("a", "alpha", 5, 5)];
    expect(applyLaneColumns(input, { laneOrder: [] })).toEqual(input);
  });
});
