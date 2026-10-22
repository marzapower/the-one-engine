import type { Currency, Prestige } from "../models/base";
import { type Decimal, N, NR } from "../nums";
import type { GameState, PrestigeRun } from "../state";
import type { Engine } from "./engine";

export { resolveTargetCode } from "./target-select";

/** Runs shorter than this never update `peakRate` (early rates are noise). */
export const RATE_MIN_RUN_MS = 60_000;
const DEFAULT_DROP = 0.95;

function currencyOf(engine: Engine, state: GameState, prestige: Prestige): Currency | undefined {
  return engine.services.registry.getByCode(state, "currency", prestige.currencyCode) as Currency | undefined;
}

/** The prestige's run record, created lazily (elapsed 0, `earnedAtStart` = current earned). */
export function getPrestigeRun(engine: Engine, state: GameState, prestige: Prestige): PrestigeRun {
  state.prestigeRuns ??= {};
  let run = state.prestigeRuns[prestige.code];
  if (!run) {
    run = { elapsedMs: 0, earnedAtStart: NR(currencyOf(engine, state, prestige)?.earned ?? 0), peakRate: NR(0) };
    state.prestigeRuns[prestige.code] = run;
  }
  return run;
}

/** Pending gain without the whole-unit floor: `raw · gainMult`, 0 below a raw gain of 1 or when not finite. */
export function continuousPrestigeGain(engine: Engine, state: GameState, prestige: Prestige): Decimal {
  const source = engine.services.adapter.getTargetValue(state, prestige.source);
  if (!source || Array.isArray(source)) return N(0);
  const raw = engine.growthValue(prestige.func, source);
  if (!raw.isFinite() || raw.lt(1)) return N(0);
  const gain = raw.mul(engine.prestigeGainMultiplier(state, prestige));
  return gain.isFinite() ? gain : N(0);
}

/** Currency per minute earned by this run if it ended now: `(continuous gain + earned − earnedAtStart) / minutes`. 0 for an empty or non-finite run. */
export function prestigeRunRate(engine: Engine, state: GameState, prestige: Prestige): Decimal {
  const run = getPrestigeRun(engine, state, prestige);
  if (!(run.elapsedMs > 0)) return N(0);
  const earned = N(currencyOf(engine, state, prestige)?.earned ?? 0);
  const total = continuousPrestigeGain(engine, state, prestige).add(earned.sub(N(run.earnedAtStart)));
  const rate = total.div(run.elapsedMs / 60_000);
  return rate.isFinite() && rate.gt(0) ? rate : N(0);
}

/**
 * True when a Fracture-style prestige is worth taking: the run lasted at least
 * `minRunMs` (default 60 s), a whole unit of gain is available, and the run
 * rate fell to `drop` (default 0.95) of its peak or below. The peak is only
 * recorded from `RATE_MIN_RUN_MS` on, so a smaller `minRunMs` has no effect.
 */
export function rateRulePrestige(engine: Engine, state: GameState, prestige: Prestige, opts?: { minRunMs?: number; drop?: number }): boolean {
  const run = getPrestigeRun(engine, state, prestige);
  if (run.elapsedMs < (opts?.minRunMs ?? RATE_MIN_RUN_MS)) return false;
  if (engine.prestigeGain(state, prestige).lt(1)) return false;
  const peak = N(run.peakRate);
  if (peak.lte(0)) return false;
  return prestigeRunRate(engine, state, prestige).lt(peak.mul(opts?.drop ?? DEFAULT_DROP));
}

/** Stage Automation, first step: advances every run clock and records the peak rate. */
export function advancePrestigeRuns(engine: Engine, state: GameState, elapsedMs: number): void {
  for (const prestige of state.prestiges) {
    const run = getPrestigeRun(engine, state, prestige);
    run.elapsedMs += elapsedMs;
    if (run.elapsedMs < RATE_MIN_RUN_MS) continue;
    const rate = prestigeRunRate(engine, state, prestige);
    if (rate.gt(N(run.peakRate))) run.peakRate = NR(rate);
  }
}

/**
 * After `performedCode` fired (and its reset cascade ran): restarts the run of
 * that prestige and of every prestige whose currency is reset by it.
 */
export function reinitPrestigeRuns(engine: Engine, state: GameState, performedCode: string): void {
  state.prestigeRuns ??= {};
  for (const code of prestigesRestartedBy(state, performedCode)) {
    const prestige = state.prestiges.find((p) => p.code === code)!;
    state.prestigeRuns[code] = { elapsedMs: 0, earnedAtStart: NR(currencyOf(engine, state, prestige)?.earned ?? 0), peakRate: NR(0) };
  }
}

/**
 * Codes of the prestiges whose run restarts when `performedCode` fires: that
 * prestige itself and every prestige whose currency it resets (a Compression
 * also restarts the Fragmentation run). Shared with UIs that keep per-run latches.
 */
export function prestigesRestartedBy(state: GameState, performedCode: string): string[] {
  return state.prestiges
    .filter((prestige) => prestige.code === performedCode || state.currencies.find((c) => c.code === prestige.currencyCode)?.resetsOn?.includes(performedCode))
    .map((prestige) => prestige.code);
}
