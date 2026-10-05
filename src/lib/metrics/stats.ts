/** Small statistics for the evaluation, written here instead of installed. */

export function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

/** Linear interpolation between closest ranks (the usual "type 7" definition). NaN for no values. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * Math.min(Math.max(p, 0), 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const lower = sorted[low] ?? 0;
  const upper = sorted[high] ?? lower;
  return lower + (upper - lower) * (rank - low);
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? Number.NaN : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** mulberry32: a small seeded generator, so a bootstrap interval is reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PairedDifference {
  n: number;
  /** Median of (newer - older), sample by sample. Negative means the newer run is closer to what the owner wrote. */
  medianDelta: number;
  /** 95% bootstrap interval for that median. */
  low: number;
  high: number;
}

/** Paired bootstrap of the median difference: resample the SAMPLES (keeping each older/newer pair together). */
export function pairedMedianDifference(newer: readonly number[], older: readonly number[], options: { iterations?: number; seed?: number } = {}): PairedDifference {
  const n = Math.min(newer.length, older.length);
  const differences = Array.from({ length: n }, (_, index) => (newer[index] ?? 0) - (older[index] ?? 0));
  if (n === 0) return { n: 0, medianDelta: Number.NaN, low: Number.NaN, high: Number.NaN };
  const random = seededRandom(options.seed ?? 20261005);
  const iterations = options.iterations ?? 2000;
  const medians: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const resample = Array.from({ length: n }, () => differences[Math.floor(random() * n)] ?? 0);
    medians.push(median(resample));
  }
  return { n, medianDelta: median(differences), low: percentile(medians, 0.025), high: percentile(medians, 0.975) };
}
