export interface TimeDomain {
  /** epoch ms */
  start: number;
  /** epoch ms; always >= start */
  end: number;
}

export function computeTimeDomain(timestamps: readonly number[]): TimeDomain | null {
  let start = Infinity;
  let end = -Infinity;
  for (const value of timestamps) {
    if (!Number.isFinite(value)) continue;
    if (value < start) start = value;
    if (value > end) end = value;
  }
  if (!Number.isFinite(start)) return null;
  return { start, end: Math.max(end, start) };
}

/** Fraction of the domain [0, 1] for a timestamp, clamped. */
export function timeFraction(domain: TimeDomain, timestamp: number): number {
  const span = domain.end - domain.start;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (timestamp - domain.start) / span));
}

const NICE_STEPS_MS = [
  1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000,
  1_800_000, 3_600_000, 7_200_000, 21_600_000, 86_400_000,
];

export interface TimeTick {
  offsetMs: number;
  fraction: number;
  label: string;
}

export function formatTickLabel(offsetMs: number): string {
  const seconds = Math.round(offsetMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}h` : `${hours}h${restMinutes}m`;
}

export interface FractionBucket<T> {
  index: number;
  /** Left edge of the bucket in domain fraction space. */
  startFraction: number;
  /** Bucket width in domain fraction space. */
  widthFraction: number;
  items: T[];
}

/**
 * Splits the domain into fixed-width buckets and drops items into them, so a
 * lane renders a bounded number of activity segments no matter how many
 * events it holds. Empty buckets are omitted.
 */
export function bucketByFraction<T>(
  items: readonly T[],
  fractionOf: (item: T) => number,
  bucketCount: number,
): FractionBucket<T>[] {
  if (bucketCount < 1 || items.length === 0) return [];
  const buckets = new Map<number, T[]>();
  for (const item of items) {
    const fraction = Math.min(1, Math.max(0, fractionOf(item)));
    const index = Math.min(bucketCount - 1, Math.floor(fraction * bucketCount));
    const bucket = buckets.get(index);
    if (bucket) bucket.push(item);
    else buckets.set(index, [item]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, bucketItems]) => ({
      index,
      startFraction: index / bucketCount,
      widthFraction: 1 / bucketCount,
      items: bucketItems,
    }));
}

/** Bucket count for a lane: precise when sparse, capped when dense. */
export function laneBucketCount(eventCount: number, max = 60): number {
  return Math.min(max, Math.max(1, eventCount));
}

/** Evenly spaced "nice" ticks covering the domain, starting at 0 offset. */
export function timeTicks(domain: TimeDomain, targetCount = 6): TimeTick[] {
  const span = domain.end - domain.start;
  if (span <= 0) return [{ offsetMs: 0, fraction: 0, label: "0s" }];
  const rawStep = span / targetCount;
  const step = NICE_STEPS_MS.find((candidate) => candidate >= rawStep) ?? NICE_STEPS_MS.at(-1)!;
  const ticks: TimeTick[] = [];
  for (let offset = 0; offset <= span; offset += step) {
    ticks.push({ offsetMs: offset, fraction: offset / span, label: formatTickLabel(offset) });
  }
  return ticks;
}
