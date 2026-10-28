import type { Engine } from "../../core/engine";
import { N } from "../../nums";
import type { GameState } from "../../state";
import type { ResolvedClickable } from "../definition";
import { runBalanceSim } from "../harness";
import { MetricsCollector } from "../metrics";
import type { GameMove, SimAction } from "../types";
import { canTapAt, isOpen, isVisit, validatePresence } from "./presence";
import { type RunLookahead, type RunPolicyOptions, createRunPolicy } from "./run-policy";
import type { OrderJob, OrderResult, RunRecord } from "./types";

const SAMPLE_INTERVAL_MS = 60_000;
const HOUR_MS = 3_600_000;

export interface SimulateOrderInput {
  /** Builds a NEW state and engine at every call: nothing is shared between orders. */
  makeSim: () => { state: GameState; engine: Engine };
  moves: (engine: Engine) => GameMove[];
  policy: RunPolicyOptions;
  job: OrderJob;
  horizonMs: number;
  /** Amounts of earned prestige currency whose first-reached time is recorded. */
  milestones: number[];
  tickLengthMs: number;
  clickable?: ResolvedClickable;
  /**
   * Labels of the run phases that hold in a state (e.g. "Carry 2", "E5"). The
   * first time each label holds in a run is recorded, from the run start, at
   * every sample and after every action: it shows where a run spends its time.
   */
  runMarks?: (state: GameState) => string[];
  /**
   * Engine tick while the page is closed (a presence only), like the game's
   * offline recovery: default 60 000 ms, one per sampling minute (production
   * only, no gestures happen there). Pass `tickLengthMs` for the exact run.
   */
  closedTickMs?: number;
  /** Engine tick of the `bestRate` look-ahead copy (default 10 000 ms): it only needs the gain at each visit. */
  lookaheadTickMs?: number;
}

/**
 * Collector that, besides the usual report, keeps what a calibration needs:
 * the shop purchases, the runs (prestige to prestige) and the first time the
 * earned prestige currency reaches each milestone. Per sample it only reads `earned`.
 */
class CalibrationCollector extends MetricsCollector {
  readonly purchases: OrderResult["purchases"] = [];
  readonly runs: RunRecord[] = [];
  readonly milestoneTimes: Record<string, number | null> = {};
  private lastRunEndMs = 0;
  private lastRunEarned: number;
  private lastSampleMs = 0;
  /** Marks of the run in progress: ms from its start. */
  private marks: Record<string, number> = {};

  constructor(
    engine: Engine,
    private readonly prestigeCurrencyCode: string,
    private readonly prestigeCode: string,
    private readonly targets: number[],
    initialState: GameState,
    private readonly runMarks?: (state: GameState) => string[],
  ) {
    super(engine);
    this.lastRunEarned = this.earned(initialState);
    for (const milestone of targets) this.milestoneTimes[String(milestone)] = null;
    this.noteMarks(initialState, 0);
  }

  /** The run still open, when marks are recorded. */
  get openRun(): OrderResult["openRun"] {
    return this.runMarks ? { startMs: this.lastRunEndMs, marks: this.marks } : undefined;
  }

  get endedAtMs(): number {
    return this.lastSampleMs;
  }

  get allMilestonesReached(): boolean {
    return this.targets.every((m) => this.milestoneTimes[String(m)] !== null);
  }

  override onSample(state: GameState, tSimMs: number): void {
    super.onSample(state, tSimMs);
    this.lastSampleMs = tSimMs;
    this.noteMilestones(this.earned(state), tSimMs);
    this.noteMarks(state, tSimMs);
  }

  override onAction(action: SimAction, state: GameState): void {
    super.onAction(action, state);
    if (action.kind === "buyUpgrade") {
      const upgrade = state.upgrades.find((u) => u.code === action.code);
      this.purchases.push({ code: action.code, level: upgrade ? N(upgrade.bought).toNumber() : 0, tSimMs: action.tSimMs });
    } else if (action.kind === "prestige" && action.code === this.prestigeCode) {
      const earned = this.earned(state);
      const gain = earned - this.lastRunEarned;
      const durationMs = action.tSimMs - this.lastRunEndMs;
      this.runs.push({
        index: this.runs.length + 1,
        startMs: this.lastRunEndMs,
        endMs: action.tSimMs,
        gain,
        ratePerHour: durationMs > 0 ? gain / (durationMs / HOUR_MS) : 0,
        ...(this.runMarks && { marks: this.marks }),
      });
      this.lastRunEndMs = action.tSimMs;
      this.lastRunEarned = earned;
      this.marks = {};
      this.noteMilestones(earned, action.tSimMs);
    }
    this.noteMarks(state, action.tSimMs);
  }

  private earned(state: GameState): number {
    const currency = state.currencies.find((c) => c.code === this.prestigeCurrencyCode);
    if (!currency) throw new Error(`prestige currency "${this.prestigeCurrencyCode}" not found`);
    // A currency starts without `earned` until the engine credits it: that is 0, never the spendable `amount`.
    return N(currency.earned ?? 0).toNumber();
  }

  private noteMarks(state: GameState, tSimMs: number): void {
    if (!this.runMarks) return;
    for (const label of this.runMarks(state)) if (!(label in this.marks)) this.marks[label] = tSimMs - this.lastRunEndMs;
  }

  private noteMilestones(earned: number, tSimMs: number): void {
    for (const milestone of this.targets) {
      const key = String(milestone);
      if (this.milestoneTimes[key] === null && earned >= milestone) this.milestoneTimes[key] = tSimMs;
    }
  }
}

/** Plays one purchase order on a fresh game and returns its runs, purchases and milestone times. Deterministic. */
export function simulateOrder(input: SimulateOrderInput): OrderResult {
  const { policy, job, horizonMs } = input;
  const presence = policy.presence;
  if (presence) {
    validatePresence(presence); // `visitMs` is ignored with a presence
  } else if (policy.visitMs <= 0 || policy.visitMs % SAMPLE_INTERVAL_MS !== 0) {
    throw new Error(`visitMs must be a positive multiple of ${SAMPLE_INTERVAL_MS} ms, got ${policy.visitMs}`);
  }

  const { state, engine } = input.makeSim();
  const prestige = state.prestiges.find((p) => p.code === policy.prestigeCode);
  if (!prestige) throw new Error(`unknown prestige "${policy.prestigeCode}"`);

  const collector = new CalibrationCollector(engine, prestige.currencyCode, prestige.code, input.milestones, state, input.runMarks);
  const moves = input.moves(engine);
  const decisionIntervalMs = presence ? SAMPLE_INTERVAL_MS : policy.visitMs;
  const tickLengthMs = input.tickLengthMs;
  const closedTickMs = input.closedTickMs ?? SAMPLE_INTERVAL_MS;
  const lookaheadTickMs = input.lookaheadTickMs ?? 10_000;
  /** Closed minutes (the sessions are minute-aligned) advance at `closedTickMs`. */
  const tickLengthAt = (t: number): number | undefined => (presence && !isOpen(presence, t) ? closedTickMs : undefined);
  /** `bestRate`: the same run on a copy, with its own engine, never prestiging; visits reported in absolute time. */
  const lookahead: RunLookahead = (from, t0, durationMs, onVisit) => {
    const fork = input.makeSim().engine;
    const copy = structuredClone(from);
    const inner = createRunPolicy({ ...policy, prestigeRule: { kind: "target", minGain: Infinity } }, job.order, moves);
    runBalanceSim({
      state: copy,
      engine: fork,
      bot: {
        id: "calibration-lookahead",
        decide: (ctx) => {
          const t = t0 + ctx.tSimMs;
          if (!presence || isVisit(presence, t)) onVisit(copy, fork, t);
          return inner.decide({ ...ctx, tSimMs: t });
        },
      },
      clickable: input.clickable,
      ...(presence && { canTap: (t: number) => canTapAt(presence, t0 + t) }),
      tickLengthAt: (t: number) => tickLengthAt(t0 + t) ?? lookaheadTickMs,
      moves,
      params: { durationMs, tickLengthMs, decisionIntervalMs, sampleIntervalMs: SAMPLE_INTERVAL_MS },
      redecideAfterMoves: true,
    });
  };
  const bot = createRunPolicy(policy, job.order, moves, policy.prestigeRule.kind === "bestRate" ? lookahead : undefined);

  runBalanceSim({
    state,
    engine,
    bot,
    collector,
    clickable: input.clickable,
    // The player taps on a visit and in the minute after it (the harness taps before deciding).
    ...(presence && { canTap: (t: number) => canTapAt(presence, t), tickLengthAt }),
    moves,
    params: { durationMs: horizonMs, tickLengthMs, decisionIntervalMs, sampleIntervalMs: SAMPLE_INTERVAL_MS },
    redecideAfterMoves: true,
    shouldStop: () => collector.purchases.length >= job.order.length && collector.allMilestonesReached,
  });

  const blocked = collector.purchases.length < job.order.length ? job.order[collector.purchases.length] : undefined;
  return {
    ...job,
    purchases: collector.purchases,
    runs: collector.runs,
    milestoneTimes: collector.milestoneTimes,
    ...(blocked && { blockedAt: { ...blocked } }),
    horizonMs,
    endedAtMs: collector.endedAtMs,
    ...(collector.openRun && { openRun: collector.openRun }),
  };
}
