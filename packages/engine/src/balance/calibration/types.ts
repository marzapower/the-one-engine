/**
 * Calibration of a prestige shop — shared contracts (design:
 * docs/superpowers/specs/2026-10-27-calibrazione-design.md). Generic: the
 * codes of entities, moves and milestones come from the consumer.
 */

/** A shop upgrade included in the calibration, with the cap on its levels. */
export interface ShopEntry {
  code: string;
  maxLevel: number;
}

/** One purchase of an order: `level` counts from 1. */
export interface OrderItem {
  code: string;
  level: number;
}

/** A purchase order: level k+1 of a code always comes after level k. */
export type ShopOrder = OrderItem[];

export type OrderOrigin = "reference" | "anticipate" | "delay" | "random" | "beam-best" | "beam-worst";

/** An order to simulate. `subject` is the upgrade code anticipated or delayed. */
export interface OrderJob {
  id: string;
  origin: OrderOrigin;
  subject?: string;
  order: ShopOrder;
}

/** One run (prestige to prestige). `gain` is the prestige currency earned in it, passive income included. */
export interface RunRecord {
  index: number;
  startMs: number;
  endMs: number;
  gain: number;
  ratePerHour: number;
  /** Milliseconds from the run start to the first time each consumer mark held (see `SimulateOrderInput.runMarks`). */
  marks?: Record<string, number>;
}

export interface OrderResult extends OrderJob {
  purchases: { code: string; level: number; tSimMs: number }[];
  runs: RunRecord[];
  /** Key: the milestone (earned prestige currency, e.g. "10"); null: not reached within the horizon. */
  milestoneTimes: Record<string, number | null>;
  /** The item the order stopped on, when it is not complete at the end. */
  blockedAt?: OrderItem;
  horizonMs: number;
  /** When the simulation actually stopped (≤ horizonMs): an order that completes early has no data past it. */
  endedAtMs: number;
  /** The run still open when the simulation stopped, with the marks reached in it (only with `runMarks`). */
  openRun?: { startMs: number; marks: Record<string, number> };
}

export interface CalibrationThresholds {
  /** Common time grid on which the orders are compared. */
  gridMs: number;
  /** Consecutive grid points over which a growing gap from the median raises a shape alarm. */
  shapeSteps: number;
  /** Total growth of that gap, in decades, for a shape alarm. */
  shapeGapGrowth: number;
  /** Median / best time to a milestone above which a shift alarm is raised (provisional). */
  shiftRatio: number;
  /** Relative growth of the run duration, three runs in a row, for a pace alarm. */
  paceRegression: number;
}

export const DEFAULT_THRESHOLDS: CalibrationThresholds = {
  gridMs: 3_600_000,
  shapeSteps: 3,
  shapeGapGrowth: 0.3,
  shiftRatio: 2,
  paceRegression: 0.1,
};
