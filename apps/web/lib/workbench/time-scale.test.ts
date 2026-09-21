import { describe, expect, it } from "vitest";

import {
  bucketByFraction,
  computeTimeDomain,
  formatTickLabel,
  laneBucketCount,
  timeFraction,
  timeTicks,
} from "./time-scale";

describe("computeTimeDomain", () => {
  it("finds min and max", () => {
    expect(computeTimeDomain([30, 10, 20])).toEqual({ start: 10, end: 30 });
  });
  it("returns null for empty input", () => {
    expect(computeTimeDomain([])).toBeNull();
  });
  it("collapses a single timestamp to a zero-width domain", () => {
    expect(computeTimeDomain([42])).toEqual({ start: 42, end: 42 });
  });
});

describe("timeFraction", () => {
  const domain = { start: 0, end: 100 };
  it("maps into [0,1] and clamps", () => {
    expect(timeFraction(domain, 50)).toBe(0.5);
    expect(timeFraction(domain, -10)).toBe(0);
    expect(timeFraction(domain, 200)).toBe(1);
  });
  it("returns 0 for a zero-width domain", () => {
    expect(timeFraction({ start: 5, end: 5 }, 5)).toBe(0);
  });
});

describe("timeTicks", () => {
  it("produces nice steps covering the span", () => {
    const ticks = timeTicks({ start: 0, end: 140_000 }, 6);
    expect(ticks[0]).toMatchObject({ offsetMs: 0, label: "0s" });
    expect(ticks.at(-1)!.offsetMs).toBeLessThanOrEqual(140_000);
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    const steps = ticks.slice(1).map((tick, index) => tick.offsetMs - ticks[index]!.offsetMs);
    expect(new Set(steps).size).toBe(1);
  });
  it("handles zero-width domains", () => {
    expect(timeTicks({ start: 9, end: 9 })).toEqual([{ offsetMs: 0, fraction: 0, label: "0s" }]);
  });
});

describe("bucketByFraction", () => {
  const items = [
    { id: "a", f: 0.0 },
    { id: "b", f: 0.04 },
    { id: "c", f: 0.5 },
    { id: "d", f: 1 },
  ];

  it("groups items into fixed buckets and omits empty ones", () => {
    const buckets = bucketByFraction(items, (item) => item.f, 10);
    expect(buckets.map((bucket) => bucket.index)).toEqual([0, 5, 9]);
    expect(buckets[0]!.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(buckets[2]!.items.map((item) => item.id)).toEqual(["d"]);
  });

  it("caps the count of rendered segments regardless of event volume", () => {
    const many = Array.from({ length: 5000 }, (_, index) => ({ f: index / 5000 }));
    expect(bucketByFraction(many, (item) => item.f, 60)).toHaveLength(60);
  });

  it("clamps out-of-range fractions into the end buckets", () => {
    const buckets = bucketByFraction([{ f: -2 }, { f: 9 }], (item) => item.f, 4);
    expect(buckets.map((bucket) => bucket.index)).toEqual([0, 3]);
  });

  it("handles empty input and degenerate bucket counts", () => {
    expect(bucketByFraction([], () => 0, 10)).toEqual([]);
    expect(bucketByFraction(items, (item) => item.f, 0)).toEqual([]);
  });
});

describe("laneBucketCount", () => {
  it("is precise when sparse and capped when dense", () => {
    expect(laneBucketCount(0)).toBe(1);
    expect(laneBucketCount(7)).toBe(7);
    expect(laneBucketCount(4000)).toBe(60);
    expect(laneBucketCount(4000, 20)).toBe(20);
  });
});

describe("formatTickLabel", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatTickLabel(20_000)).toBe("20s");
    expect(formatTickLabel(120_000)).toBe("2m");
    expect(formatTickLabel(90_000)).toBe("1m30s");
    expect(formatTickLabel(3_600_000)).toBe("1h");
    expect(formatTickLabel(4_200_000)).toBe("1h10m");
  });
});
