import type { Engine } from "../core/engine";
import { type Decimal, N } from "../nums";
import type { GameState } from "../state";
import { anyActionAvailable } from "./queries";
import { DEFAULT_HARNESS_PARAMS } from "./types";
import type { BalanceReport, DeadTimeWindow, DecadeTime, DecisionDensityWindow, MilestoneEvent, PrestigeCycle, SeriesSample, SimAction } from "./types";

const FIVE_MIN_MS = 5 * 60 * 1000;
/** Clamp for `primaryPersec` — keeps the series JSON-friendly at extreme scales. */
const PERSEC_CLAMP = 1e300;

/** Optional telemetry codes: extra series channels beyond the primary currency (data-driven — `Currency.primary`). Unset channels sample as -1. */
export interface MetricsCodes {
  overflowCurrencyCode?: string;
  trackedProducerCode?: string;
}

/**
 * Pluggable one-shot milestone detector: called at every sample until it
 * returns an event, then retired. This is how optional mechanics (e.g.
 * saturation onset, see saturation-onset.ts) hook into the otherwise generic
 * collector without the collector knowing any specific mechanic.
 */
export type MilestoneDetector = (state: GameState, tSimMs: number) => MilestoneEvent | undefined;

/**
 * Collects a `BalanceReport` from a simulated run: samples the state
 * periodically (`onSample`) and records applied bot actions (`onAction`),
 * then assembles everything into the report shape defined in types.ts.
 *
 * `finalize` fills `meta` with sensible standalone defaults (empty botId,
 * default params, zero droppedIntents); the harness overwrites those fields
 * with the actual run parameters after calling `finalize`.
 */
export class MetricsCollector {
  private readonly overflowCode: string | undefined;
  private readonly trackedProducerCode: string | undefined;
  private pendingDetectors: MilestoneDetector[];
  /** Engine used to price dead-time availability (see `anyActionAvailable`). */
  private readonly engine: Engine;

  constructor(engine: Engine, codes: MetricsCodes = {}, detectors: MilestoneDetector[] = []) {
    this.overflowCode = codes.overflowCurrencyCode;
    this.trackedProducerCode = codes.trackedProducerCode;
    this.pendingDetectors = [...detectors];
    this.engine = engine;
  }

  private readonly milestones: MilestoneEvent[] = [];
  private readonly series: SeriesSample[] = [];
  private readonly decadeTimes: DecadeTime[] = [];
  private readonly deadWindows: DeadTimeWindow[] = [];
  private readonly actions: SimAction[] = [];
  private readonly actionsCount: Record<string, number> = {};
  private readonly prestigeCycles: PrestigeCycle[] = [];
  private readonly firstBuySeen = new Set<string>();

  private lastCrossedDecade = -1;
  private lastDecadeCrossMs = 0;

  private currentDeadWindowStart: number | null = null;

  private lastBuyCode: string | null = null;
  private rotationSwitches = 0;

  private lastPrestigeMs = 0;
  private prestigeCount = 0;

  onSample(state: GameState, tSimMs: number): void {
    const primaryCurrency = state.currencies.find((c) => c.primary);
    const overflowCurrency = this.overflowCode === undefined ? undefined : state.currencies.find((c) => c.code === this.overflowCode);
    const trackedProducer = this.trackedProducerCode === undefined ? undefined : state.producers.find((p) => p.code === this.trackedProducerCode);

    const primaryAmount = N(primaryCurrency?.amount ?? 0);
    const overflowAmount = N(overflowCurrency?.amount ?? 0);
    const trackedAmount = N(trackedProducer?.amount ?? 0);

    const log10Primary = primaryAmount.lte(0) ? -1 : primaryAmount.log10().toNumber();
    const log10Overflow = overflowAmount.lte(0) ? -1 : overflowAmount.log10().toNumber();
    const log10TrackedProducer = trackedAmount.lte(0) ? -1 : trackedAmount.log10().toNumber();

    const persecRaw = N(primaryCurrency?.persecDelta ?? 0).toNumber();
    const primaryPersec = Number.isFinite(persecRaw) ? Math.min(persecRaw, PERSEC_CLAMP) : PERSEC_CLAMP;

    this.series.push({ tSimMs, log10Primary, log10Overflow, log10TrackedProducer, primaryPersec });

    this.detectDecades(primaryAmount, tSimMs, primaryCurrency?.code);
    this.runDetectors(state, tSimMs);
    this.detectDeadTime(state, tSimMs);
  }

  onAction(action: SimAction, _state: GameState): void {
    this.actions.push(action);
    this.actionsCount[action.code] = (this.actionsCount[action.code] ?? 0) + 1;

    if (action.kind === "buyProducer" || action.kind === "buyUpgrade") {
      if (!this.firstBuySeen.has(action.code)) {
        this.firstBuySeen.add(action.code);
        this.milestones.push({ event: `buy:first:${action.code}`, tSimMs: action.tSimMs });
      }
      if (this.lastBuyCode !== null && this.lastBuyCode !== action.code) {
        this.rotationSwitches++;
      }
      this.lastBuyCode = action.code;
    } else if (action.kind === "prestige") {
      this.prestigeCount++;
      this.milestones.push({
        event: `prestige:${this.prestigeCount}`,
        tSimMs: action.tSimMs,
        detail: { code: action.code, gain: String(N(action.gain)) },
      });
      this.prestigeCycles.push({
        index: this.prestigeCount,
        startMs: this.lastPrestigeMs,
        endMs: action.tSimMs,
        gain: String(N(action.gain)),
      });
      this.lastPrestigeMs = action.tSimMs;
    }
  }

  finalize(state: GameState, tSimMs: number): BalanceReport {
    if (this.currentDeadWindowStart !== null) {
      this.deadWindows.push({ fromMs: this.currentDeadWindowStart, toMs: tSimMs });
      this.currentDeadWindowStart = null;
    }
    const totalDeadMs = this.deadWindows.reduce((acc, w) => acc + (w.toMs - w.fromMs), 0);

    const decisionDensity = this.buildDecisionDensity(tSimMs);
    const hours = tSimMs / (60 * 60 * 1000);
    const perHour = hours > 0 ? this.rotationSwitches / hours : 0;

    return {
      meta: {
        botId: "",
        params: DEFAULT_HARNESS_PARAMS,
        generatedAt: new Date().toISOString(),
        droppedIntents: 0,
        validationErrors: state.stats.validationErrors,
      },
      milestones: this.milestones,
      series: this.series,
      decadeTimes: this.decadeTimes,
      deadTime: { totalMs: totalDeadMs, windows: this.deadWindows },
      decisionDensity,
      purchaseRotation: { switches: this.rotationSwitches, perHour },
      prestigeCycles: this.prestigeCycles,
      actionsCount: this.actionsCount,
      actions: this.actions,
    };
  }

  private detectDecades(primaryAmount: Decimal, tSimMs: number, primaryCode: string | undefined): void {
    if (primaryCode === undefined || primaryAmount.lte(0)) return;
    const flooredK = Math.floor(primaryAmount.log10().toNumber());
    if (flooredK < 0 || flooredK <= this.lastCrossedDecade) return;

    for (let k = this.lastCrossedDecade + 1; k <= flooredK; k++) {
      this.milestones.push({ event: `decade:${primaryCode}:${k}`, tSimMs });
      this.decadeTimes.push({ decade: k, tSimMs, deltaMs: tSimMs - this.lastDecadeCrossMs });
      this.lastDecadeCrossMs = tSimMs;
    }
    this.lastCrossedDecade = flooredK;
  }

  private runDetectors(state: GameState, tSimMs: number): void {
    if (this.pendingDetectors.length === 0) return;

    this.pendingDetectors = this.pendingDetectors.filter((detector) => {
      const milestone = detector(state, tSimMs);
      if (milestone) this.milestones.push(milestone);
      return !milestone;
    });
  }

  private detectDeadTime(state: GameState, tSimMs: number): void {
    const dead = !anyActionAvailable(this.engine, state);
    if (dead) {
      this.currentDeadWindowStart ??= tSimMs;
    } else if (this.currentDeadWindowStart !== null) {
      this.deadWindows.push({ fromMs: this.currentDeadWindowStart, toMs: tSimMs });
      this.currentDeadWindowStart = null;
    }
  }

  private buildDecisionDensity(totalMs: number): DecisionDensityWindow[] {
    const windowCount = Math.max(1, Math.ceil(totalMs / FIVE_MIN_MS));
    const windows: DecisionDensityWindow[] = [];

    for (let i = 0; i < windowCount; i++) {
      const windowStartMs = i * FIVE_MIN_MS;
      const windowEndMs = windowStartMs + FIVE_MIN_MS;
      const count = this.actions.filter((a) => a.tSimMs >= windowStartMs && a.tSimMs < windowEndMs).length;
      windows.push({ windowStartMs, actionsPerMin: count / 5 });
    }

    return windows;
  }
}
