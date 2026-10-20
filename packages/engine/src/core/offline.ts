import { TICK_MS_INTERVAL } from "../constants";
import type { Numerus } from "../nums";

/** Tick length `simulateOffline` uses for a given duration: full fidelity under 1 min, 250ms under 1h, 1000ms beyond. */
export function offlineTickLength(durationMs: number): number {
  if (durationMs < 60_000) return TICK_MS_INTERVAL;
  if (durationMs < 3_600_000) return 250;
  return 1000;
}

/**
 * Report from `Engine.simulateOffline`: what an offline stretch produced.
 *
 * The simulation uses an adaptive coarse-tick strategy:
 * - < 60s: full-fidelity ticks (the engine's normal tick length)
 * - < 1h: 250ms ticks
 * - < 24h: 1000ms ticks
 * - >= 24h: capped to 24h, with `durationCapped` set
 *
 * Saturation overflow accumulation is preserved throughout, at whatever
 * fidelity the tick length allows.
 */
export interface OfflineReport {
  /** Actual simulated duration in ms (may be capped to 24h). */
  durationMs: number;

  /** Original requested duration in ms. */
  durationRequestedMs: number;

  /** True if the 24h cap was applied. */
  durationCapped: boolean;

  /** Tick length selected by policy. */
  tickLengthUsed: number;

  /** Number of ticks executed: `floor(durationMs / tickLengthUsed)`. */
  ticksRun: number;

  /** Per-currency-code deltas accumulated offline. */
  deltaCurrencies: Record<string, Numerus>;

  /** Timestamp when the simulation started. */
  startedAt: number;

  /** Timestamp when the simulation finished. */
  finishedAt: number;
}
