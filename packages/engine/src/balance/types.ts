import type { Engine } from "../core/engine";
import type { Numerus } from "../nums";
import type { GameState } from "../state";

/**
 * Balance harness contracts — shared types for the simulation-driven
 * balance tooling.
 *
 * Architecture:
 * - A `BotPolicy` produces `BotIntent`s at each decision point.
 * - The harness (`harness.ts`) applies intents to the state (single point of
 *   mutation), turning them into `SimAction`s, and forwards them to the
 *   `MetricsCollector` (`metrics.ts`).
 * - The collector samples the state periodically and assembles a
 *   `BalanceReport` at the end of the run.
 */

// ---------------------------------------------------------------------------
// Bot layer
// ---------------------------------------------------------------------------

/** A purchase/prestige intent decided by a policy. The harness validates and applies it. */
export type BotIntent = { kind: "buyProducer"; code: string; amount: number } | { kind: "buyUpgrade"; code: string } | { kind: "prestige"; code: string };

/** An applied intent, enriched by the harness with cost/gain and sim time. */
export type SimAction =
  | { kind: "buyProducer"; code: string; amount: number; cost: Numerus; tSimMs: number }
  | { kind: "buyUpgrade"; code: string; cost: Numerus; tSimMs: number }
  | { kind: "prestige"; code: string; gain: Numerus; tSimMs: number };

export interface BotContext {
  state: GameState;
  engine: Engine;
  /** Simulated time since run start, in ms. */
  tSimMs: number;
}

export interface BotPolicy {
  readonly id: string;
  /**
   * Called once per decision point. May return multiple intents; the harness
   * applies them in order and silently drops unaffordable/invalid ones
   * (counting drops in the report meta). Return [] when there is nothing to do.
   *
   * Lifecycle contract: the harness MUST reuse the same BotPolicy instance for
   * the whole run — policies may keep internal per-run state across decide()
   * calls (e.g. stall detection timestamps).
   */
  decide(ctx: BotContext): BotIntent[];
}

// ---------------------------------------------------------------------------
// Harness layer
// ---------------------------------------------------------------------------

export interface HarnessParams {
  /** Total simulated duration in ms (default 2h). */
  durationMs: number;
  /** Engine tick length in ms (default 250 — coarse tick validated by offline.test.ts). */
  tickLengthMs: number;
  /** How often the bot is consulted, in simulated ms (default 5000). */
  decisionIntervalMs: number;
  /** How often the collector samples the state, in simulated ms (default 1000). */
  sampleIntervalMs: number;
  /** Safety cap on applied intents per decision point (default 50). */
  maxActionsPerDecision: number;
}

export const DEFAULT_HARNESS_PARAMS: HarnessParams = {
  durationMs: 2 * 60 * 60 * 1000,
  tickLengthMs: 250,
  decisionIntervalMs: 5_000,
  sampleIntervalMs: 1_000,
  maxActionsPerDecision: 50,
};

// ---------------------------------------------------------------------------
// Metrics layer
// ---------------------------------------------------------------------------

/**
 * Milestone event codes (string, extensible):
 * - `buy:first:<code>`      — first purchase of a producer/upgrade
 * - `decade:<primary>:<k>`  — the primary currency crosses 10^k for the first time
 * - `saturation:onset`      — first sample where some producer's support ratio drops below 1
 * - `prestige:<n>`          — n-th prestige performed (1-based)
 */
export interface MilestoneEvent {
  event: string;
  tSimMs: number;
  detail?: Record<string, unknown>;
}

export interface SeriesSample {
  tSimMs: number;
  /** log10 of the primary currency's amount (0 or below clamps to -1). */
  log10Primary: number;
  /** log10 of the saturation overflow currency's amount, same clamping. -1 without one. */
  log10Overflow: number;
  /** log10 of the tracked producer's unit stock (`amount`), same clamping. -1 without one. */
  log10TrackedProducer: number;
  /** Current primary-currency per-second production (from persecDelta), as plain number (log-safe scale). */
  primaryPersec: number;
}

/** Time spent to cross one order of magnitude of the primary currency. */
export interface DecadeTime {
  /** Decade index k: time from first crossing of 10^(k-1) to first crossing of 10^k. */
  decade: number;
  /** Sim time at which 10^k was crossed. */
  tSimMs: number;
  /** Duration of the crossing, ms. */
  deltaMs: number;
}

/**
 * A sample point is "dead" when NO action is available:
 * no producer's next single unit is affordable, no upgrade is affordable,
 * and no prestige would yield a positive gain.
 * Consecutive dead samples merge into windows.
 */
export interface DeadTimeWindow {
  fromMs: number;
  toMs: number;
}

export interface DecisionDensityWindow {
  /** Start of a 5-minute window. */
  windowStartMs: number;
  /** Applied actions per minute within the window. */
  actionsPerMin: number;
}

export interface PrestigeCycle {
  /** 1-based cycle index. */
  index: number;
  startMs: number;
  endMs: number;
  /** Prestige currency gained, stringified Decimal. */
  gain: string;
}

export interface BalanceReportMeta {
  botId: string;
  params: HarnessParams;
  generatedAt: string;
  /** Intents dropped by the harness (unaffordable/invalid). */
  droppedIntents: number;
  /** Engine validation errors present at end of run (must be [] for a valid report). */
  validationErrors: string[];
}

export interface BalanceReport {
  meta: BalanceReportMeta;
  milestones: MilestoneEvent[];
  series: SeriesSample[];
  decadeTimes: DecadeTime[];
  deadTime: { totalMs: number; windows: DeadTimeWindow[] };
  decisionDensity: DecisionDensityWindow[];
  /** Attention-rotation proxy: number of times the purchased entity code changes between consecutive buy actions. */
  purchaseRotation: { switches: number; perHour: number };
  prestigeCycles: PrestigeCycle[];
  /** Count of applied actions per entity code. */
  actionsCount: Record<string, number>;
  actions: SimAction[];
}
