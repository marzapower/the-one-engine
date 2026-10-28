/**
 * Calibration analysis: turns the results of many simulated purchase orders
 * into alarms (shape, shift, pace) and per-upgrade sensitivity (design:
 * docs/superpowers/specs/2026-10-27-calibrazione-design.md, §5b and §6).
 * Pure and generic. No NaN or Infinity in the output: missing values are null.
 */
import { type CalibrationThresholds, DEFAULT_THRESHOLDS, type OrderItem, type OrderOrigin, type OrderResult } from "./types";

export interface Alarm {
  kind: "shape" | "shift" | "pace";
  orderId: string;
  /** For "shift". */
  milestone?: string;
  /** For "shape": the first item where the order differs from the reference. */
  firstDivergence?: OrderItem;
  /** Italian sentence with the numbers. */
  detail: string;
}

export interface Sensitivity {
  code: string;
  /** Milliseconds against the reference; null when either time is censored. */
  milestoneDelta: Record<string, { anticipate: number | null; delay: number | null }>;
}

/** Median phases of the n-th run, over the orders of the median that played it. */
export interface RunPhases {
  run: number;
  /** Orders that completed this run. */
  orders: number;
  /** Median duration of the run. */
  durationMs: number | null;
  /** Per mark: median ms from the run start, over the runs that reached it; null when none did. */
  marks: Record<string, number | null>;
  /** Per mark: how many of those runs reached it. */
  reached: Record<string, number>;
}

export interface CalibrationAnalysis {
  thresholds: CalibrationThresholds;
  results: OrderResult[];
  /** Instants of the common grid. */
  grid: number[];
  /** Median log10 rate per grid point (reference/anticipate/delay/random orders only). */
  median: (number | null)[];
  /** Per order: log10 rate minus the median. */
  gaps: Record<string, (number | null)[]>;
  milestoneSummary: Record<string, { best: number | null; median: number | null; ratio: number | null }>;
  sensitivity: Sensitivity[];
  alarms: Alarm[];
  /** Marks found in the runs, by median time from the run start. Empty without `runMarks`. */
  phaseMarks: string[];
  phases: RunPhases[];
  /** First purchase (level 1) of each code in the orders: best over all results, median over the median origins (never = +inf, so null). */
  firstPurchase: Record<string, { best: number | null; median: number | null }>;
}

/** Pace: how many of the last runs are compared for the "no longer accelerating" alarm. */
const PACE_FLAT_RUNS = 5;
/** Pace: minimum relative drop of the run duration over those runs; below it the pace is flat. */
const PACE_FLAT_GAIN = 0.05;

/** Origins that form the median; beam extremes are labelled and kept out. */
const MEDIAN_ORIGINS: ReadonlySet<OrderOrigin> = new Set(["reference", "anticipate", "delay", "random"]);

/** Number in Italian format (decimal comma) with `digits` decimals. */
function it(value: number, digits = 2): string {
  return value.toFixed(digits).replace(".", ",");
}

/** Hours in Italian format with at most two decimals ("1,5 h"), "-" when missing; `signed` prefixes "+" on positives. */
export function formatHours(ms: number | null | undefined, signed = false): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "-";
  const h = Math.round((ms / 3_600_000) * 100) / 100;
  const text = String(h).replace(".", ",");
  return signed && h > 0 ? `+${text} h` : `${text} h`;
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const value = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Number.isFinite(value) ? value : null;
}

/**
 * log10 of the rate at each grid point: the rate of the last run ended by then.
 * null before the first run, for a non-positive rate and past `endedAtMs`
 * (the simulation stopped there: there is no data, the last rate is not carried on).
 */
export function rateSeries(result: OrderResult, grid: number[]): (number | null)[] {
  const runs = [...result.runs].sort((a, b) => a.endMs - b.endMs);
  return grid.map((t) => {
    if (t > result.endedAtMs) return null;
    let rate: number | null = null;
    for (const run of runs) {
      if (run.endMs > t) break;
      rate = run.ratePerHour;
    }
    return rate === null || !Number.isFinite(rate) || rate <= 0 ? null : Math.log10(rate);
  });
}

function firstDivergence(order: OrderItem[], reference: OrderItem[]): OrderItem | undefined {
  for (let i = 0; i < order.length; i++) {
    const item = order[i]!;
    const ref = reference[i];
    if (!ref || ref.code !== item.code || ref.level !== item.level) return { code: item.code, level: item.level };
  }
  return undefined;
}

function timeOf(result: OrderResult, key: string): number {
  const t = result.milestoneTimes[key];
  return t === null || t === undefined ? Infinity : t;
}

export function analyzeCalibration(results: OrderResult[], milestones: number[], thresholds?: Partial<CalibrationThresholds>): CalibrationAnalysis {
  const th: CalibrationThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const reference = results.find((r) => r.origin === "reference");
  if (!reference) throw new Error("analyzeCalibration: no result with origin 'reference' among the results");

  // Common grid, from 0 to the largest horizon.
  const maxHorizon = results.reduce((m, r) => Math.max(m, r.horizonMs), 0);
  const grid: number[] = [];
  for (let t = 0; t <= maxHorizon; t += th.gridMs) grid.push(t);

  const logRates = new Map<string, (number | null)[]>();
  for (const r of results) logRates.set(r.id, rateSeries(r, grid));

  const median = grid.map((_, i) => {
    const values: number[] = [];
    for (const r of results) {
      if (!MEDIAN_ORIGINS.has(r.origin)) continue;
      const v = logRates.get(r.id)![i];
      if (v !== null && v !== undefined) values.push(v);
    }
    return medianOf(values);
  });

  const gaps: Record<string, (number | null)[]> = {};
  for (const r of results) {
    gaps[r.id] = logRates.get(r.id)!.map((v, i) => {
      const m = median[i];
      return v === null || v === undefined || m === null || m === undefined ? null : v - m;
    });
  }

  const alarms: Alarm[] = [];

  // Shape: the gap does not decrease (plateaus allowed) over at least `shapeSteps` consecutive points, by at least `shapeGapGrowth` in total, and ends positive.
  for (const r of results) {
    const series = gaps[r.id]!;
    let final: number | null = null;
    for (const g of series) if (g !== null) final = g;
    if (final === null || final <= 0) continue;
    let found: { steps: number; growth: number; atMs: number } | undefined;
    let start = -1;
    for (let i = 1; i <= series.length; i++) {
      const prev = series[i - 1];
      const cur = series[i];
      // Non-decreasing: plateaus (equal values on the hourly grid) do not break the growth.
      const rising = i < series.length && prev !== null && prev !== undefined && cur !== null && cur !== undefined && cur >= prev;
      if (rising) {
        if (start < 0) start = i - 1;
        continue;
      }
      if (start >= 0) {
        const steps = i - 1 - start;
        const growth = series[i - 1]! - series[start]!;
        if (steps >= th.shapeSteps && growth >= th.shapeGapGrowth && (!found || growth > found.growth)) {
          found = { steps, growth, atMs: grid[start]! };
        }
        start = -1;
      }
    }
    if (!found) continue;
    const divergence = firstDivergence(r.order, reference.order);
    const alarm: Alarm = {
      kind: "shape",
      orderId: r.id,
      detail:
        `L'ordine ${r.id} si stacca dalla mediana di ${it(found.growth)} decadi in ${found.steps} punti consecutivi ` +
        `a partire da ${formatHours(found.atMs)}, e alla fine il distacco è +${it(final)} decadi.`,
    };
    if (divergence) {
      alarm.firstDivergence = divergence;
      alarm.detail += ` Prima voce diversa dal riferimento: ${divergence.code} livello ${divergence.level}.`;
    }
    alarms.push(alarm);
  }

  // Shift: median / best time to each milestone.
  const milestoneSummary: CalibrationAnalysis["milestoneSummary"] = {};
  for (const m of milestones) {
    const key = String(m);
    let best = Infinity;
    let bestId = reference.id;
    for (const r of results) {
      const t = timeOf(r, key);
      if (t < best) {
        best = t;
        bestId = r.id;
      }
    }
    const medianTime = medianOf(results.filter((r) => MEDIAN_ORIGINS.has(r.origin)).map((r) => timeOf(r, key)));
    // medianOf maps non-finite results to null, which is exactly "median is +inf".
    const bestOut = Number.isFinite(best) ? best : null;
    const ratio = bestOut !== null && bestOut > 0 && medianTime !== null ? medianTime / bestOut : null;
    milestoneSummary[key] = { best: bestOut, median: medianTime, ratio };
    // The widest shift of all: the best order reaches the milestone, the median one never does.
    if (bestOut !== null && medianTime === null) {
      alarms.push({
        kind: "shift",
        orderId: bestId,
        milestone: key,
        detail: `Al traguardo ${key} l'ordine ${bestId} arriva in ${formatHours(bestOut)}, mentre la mediana degli ordini non ci arriva entro l'orizzonte.`,
      });
    } else if (ratio !== null && ratio > th.shiftRatio) {
      alarms.push({
        kind: "shift",
        orderId: bestId,
        milestone: key,
        detail:
          `Al traguardo ${key} l'ordine ${bestId} arriva in ${formatHours(bestOut!)} contro una mediana di ${formatHours(medianTime!)}: ` +
          `rapporto ${it(ratio)} sopra la soglia ${it(th.shiftRatio)}.`,
      });
    }
  }

  // Pace: run durations growing by more than `paceRegression` three runs in a row, or no longer shrinking over the last runs.
  for (const r of results) {
    const durations = r.runs.map((run) => run.endMs - run.startMs);
    let streak = 0;
    let slowing = false;
    for (let i = 1; i < durations.length; i++) {
      const prev = durations[i - 1]!;
      streak = prev > 0 && durations[i]! > prev * (1 + th.paceRegression) ? streak + 1 : 0;
      if (streak >= 3) {
        alarms.push({
          kind: "pace",
          orderId: r.id,
          detail: `L'ordine ${r.id} rallenta: le ultime quattro run durano ${durations
            .slice(i - 3, i + 1)
            .map((d) => formatHours(d))
            .join(", ")}, ogni volta oltre il ${it(th.paceRegression * 100, 0)}% in più della precedente.`,
        });
        slowing = true;
        break;
      }
    }
    if (slowing || durations.length < PACE_FLAT_RUNS) continue;
    const lastRuns = durations.slice(-PACE_FLAT_RUNS);
    const first = lastRuns[0]!;
    const last = lastRuns[lastRuns.length - 1]!;
    if (first > 0 && last >= first * (1 - PACE_FLAT_GAIN)) {
      alarms.push({
        kind: "pace",
        orderId: r.id,
        detail:
          `L'ordine ${r.id}: il ritmo non accelera più. Nelle ultime ${PACE_FLAT_RUNS} run la durata passa da ${formatHours(first)} a ${formatHours(last)}, ` +
          `senza calare di almeno il ${it(PACE_FLAT_GAIN * 100, 0)}%.`,
      });
    }
  }

  // Sensitivity: milestone time deltas of anticipated / delayed orders against the reference.
  const codes: string[] = [];
  for (const r of results) {
    if ((r.origin === "anticipate" || r.origin === "delay") && r.subject !== undefined && !codes.includes(r.subject)) codes.push(r.subject);
  }
  const delta = (r: OrderResult | undefined, key: string): number | null => {
    if (!r) return null;
    const a = r.milestoneTimes[key];
    const b = reference.milestoneTimes[key];
    return a === null || a === undefined || b === null || b === undefined ? null : a - b;
  };
  const sensitivity: Sensitivity[] = codes.map((code) => {
    const ant = results.find((r) => r.origin === "anticipate" && r.subject === code);
    const del = results.find((r) => r.origin === "delay" && r.subject === code);
    const milestoneDelta: Sensitivity["milestoneDelta"] = {};
    for (const m of milestones) {
      const key = String(m);
      milestoneDelta[key] = { anticipate: delta(ant, key), delay: delta(del, key) };
    }
    return { code, milestoneDelta };
  });

  const { phaseMarks, phases } = summarizePhases(results.filter((r) => MEDIAN_ORIGINS.has(r.origin)));

  const firstPurchase = summarizeFirstPurchase(results);

  return { thresholds: th, results, grid, median, gaps, milestoneSummary, sensitivity, alarms, phaseMarks, phases, firstPurchase };
}

/** Instant of the first level-1 purchase of `code`; +inf when the order never buys it. */
function firstPurchaseTime(result: OrderResult, code: string): number {
  let first = Infinity;
  for (const p of result.purchases) if (p.code === code && p.level === 1 && p.tSimMs < first) first = p.tSimMs;
  return first;
}

/** Every code found in the orders gets an entry, even when no order buys it. */
function summarizeFirstPurchase(results: OrderResult[]): CalibrationAnalysis["firstPurchase"] {
  const codes: string[] = [];
  for (const r of results) for (const item of r.order) if (item.level === 1 && !codes.includes(item.code)) codes.push(item.code);
  const out: CalibrationAnalysis["firstPurchase"] = {};
  for (const code of codes) {
    const best = results.reduce((m, r) => Math.min(m, firstPurchaseTime(r, code)), Infinity);
    const median = medianOf(results.filter((r) => MEDIAN_ORIGINS.has(r.origin)).map((r) => firstPurchaseTime(r, code)));
    out[code] = { best: Number.isFinite(best) ? best : null, median };
  }
  return out;
}

/** Median run phases by run number; marks sorted by their median time over all runs. */
function summarizePhases(results: OrderResult[]): { phaseMarks: string[]; phases: RunPhases[] } {
  const allTimes = new Map<string, number[]>();
  for (const r of results) for (const run of r.runs) for (const [label, t] of Object.entries(run.marks ?? {})) allTimes.set(label, [...(allTimes.get(label) ?? []), t]);
  if (allTimes.size === 0) return { phaseMarks: [], phases: [] };
  const phaseMarks = [...allTimes.keys()].sort((a, b) => (medianOf(allTimes.get(a)!) ?? 0) - (medianOf(allTimes.get(b)!) ?? 0) || a.localeCompare(b));

  const runCount = results.reduce((m, r) => Math.max(m, r.runs.length), 0);
  const phases: RunPhases[] = [];
  for (let i = 0; i < runCount; i++) {
    const runs = results.flatMap((r) => (r.runs[i] ? [r.runs[i]!] : []));
    const marks: RunPhases["marks"] = {};
    const reached: RunPhases["reached"] = {};
    for (const label of phaseMarks) {
      const times = runs.flatMap((run) => (run.marks && label in run.marks ? [run.marks[label]!] : []));
      marks[label] = medianOf(times);
      reached[label] = times.length;
    }
    phases.push({ run: i + 1, orders: runs.length, durationMs: medianOf(runs.map((run) => run.endMs - run.startMs)), marks, reached });
  }
  return { phaseMarks, phases };
}
