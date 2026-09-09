import { describe, expect, it } from "vitest";

import { TICK_MS_INTERVAL } from "../constants";
import type { Currency, Producer } from "../models/base";
import { ScaleOn, ScalingMethod } from "../models/base";
import { N, NR } from "../nums";
import { type GameState, createInitialState } from "../state";
import { MockStateAdapter } from "../testing/MockStateAdapter";
import { MockTimeProvider } from "../testing/MockTimeProvider";
import { Engine } from "./engine";

function createTestGameState(): GameState {
  const oneCurrency: Currency = { code: "one", name: "One", amount: NR(10000) };
  const overflowCurrency: Currency = { code: "dd", name: "Overflow", amount: NR(0), earned: NR(0) };

  const e1Producer: Producer = {
    code: "e1",
    name: "E1",
    currencyCode: "one",
    amount: NR(0),
    bought: NR(0),
    produces: [{ code: "one", persec: NR(100) }],
    scaling: { base: NR(10), coeff: NR(1.2), scaleOn: ScaleOn.self, func: ScalingMethod.Geometric },
    capacity: { base: NR(1000), factor: NR(1.04), decayScale: 18, overflowRate: 0.05 },
  };

  return {
    ...createInitialState(),
    producers: [e1Producer],
    currencies: [oneCurrency, overflowCurrency],
    rules: { saturation: { overflowCurrencyCode: "dd", decayExponent: 2 } },
  };
}

function newEngine() {
  const state = createTestGameState();
  const time = new MockTimeProvider(16);
  const adapter = new MockStateAdapter();
  const engine = new Engine(16, { time, state: adapter });
  return { state, engine, adapter };
}

describe("Engine.simulateOffline", () => {
  it("determinism: two identical calls produce same deltaCurrencies", () => {
    const run1 = newEngine();
    const run2 = newEngine();

    const report1 = run1.engine.simulateOffline(run1.state, 60_000);
    const report2 = run2.engine.simulateOffline(run2.state, 60_000);

    expect(report1.deltaCurrencies.one).toEqual(report2.deltaCurrencies.one);
    expect(report1.deltaCurrencies.dd).toEqual(report2.deltaCurrencies.dd);
  });

  it("coarse vs fine: 1h coarse vs 60x1min fine (divergence < 10%)", () => {
    const stateCoarse = createTestGameState();
    const stateFine = createTestGameState();

    const e1Coarse = stateCoarse.producers[0];
    const e1Fine = stateFine.producers[0];
    if (!e1Coarse || !e1Fine) throw new Error("e1 not found");

    e1Coarse.bought = NR(5);
    e1Coarse.amount = NR(5);
    e1Fine.bought = NR(5);
    e1Fine.amount = NR(5);

    const engineCoarse = new Engine(TICK_MS_INTERVAL, { time: new MockTimeProvider(TICK_MS_INTERVAL), state: new MockStateAdapter() });
    const reportCoarse = engineCoarse.simulateOffline(stateCoarse, 60 * 60 * 1000);

    const engineFine = new Engine(TICK_MS_INTERVAL, { time: new MockTimeProvider(TICK_MS_INTERVAL), state: new MockStateAdapter() });
    let accumulatedDeltaOne = N(0);
    for (let i = 0; i < 60; i++) {
      const reportFine = engineFine.simulateOffline(stateFine, 60 * 1000);
      accumulatedDeltaOne = accumulatedDeltaOne.add(N(reportFine.deltaCurrencies.one ?? 0));
    }

    const coarseOne = N(reportCoarse.deltaCurrencies.one ?? 0);
    const fineOne = accumulatedDeltaOne;
    const divergenceFactor = coarseOne.gt(0) ? fineOne.div(coarseOne).toNumber() : 1;

    expect(divergenceFactor).toBeGreaterThan(0.9);
    expect(divergenceFactor).toBeLessThan(1.1);
  });

  it("cap at 24h: simulateOffline(state, 48h) -> durationCapped true, durationMs = 24h", () => {
    const { state, engine } = newEngine();
    const maxOfflineMs = 24 * 60 * 60 * 1000;
    const report = engine.simulateOffline(state, 48 * 60 * 60 * 1000);

    expect(report.durationCapped).toBe(true);
    expect(report.durationMs).toBe(maxOfflineMs);
    expect(report.durationRequestedMs).toBe(48 * 60 * 60 * 1000);
  });

  it("overflow accumulation: a producer above its capacity, run offline, deltaCurrencies[overflowCode] > 0", () => {
    const { state, engine } = newEngine();

    // Push e1 well above its capacity (base 1000, factor 1.04) so its output
    // is throttled and the lost fraction overflows into "dd".
    const e1 = state.producers[0]!;
    e1.bought = NR(10);
    e1.amount = NR(1e12);

    const report = engine.simulateOffline(state, 10_000);
    expect(N(report.deltaCurrencies.dd ?? 0).gt(0)).toBe(true);
  });

  it("empty state: no producers -> all deltaCurrencies zero", () => {
    const state = createTestGameState();
    state.producers = [];

    const { engine } = newEngine();
    const report = engine.simulateOffline(state, 30_000);

    expect(N(report.deltaCurrencies.one ?? 0).toNumber()).toBe(0);
  });

  it("tickLength selection: < 60s uses TICK_MS_INTERVAL", () => {
    const { state, engine } = newEngine();
    const report = engine.simulateOffline(state, 30_000);
    expect(report.tickLengthUsed).toBe(TICK_MS_INTERVAL);
  });

  it("tickLength selection: < 1h uses 250ms", () => {
    const { state, engine } = newEngine();
    const report = engine.simulateOffline(state, 59 * 60 * 1000);
    expect(report.tickLengthUsed).toBe(250);
  });

  it("tickLength selection: >= 1h uses 1000ms", () => {
    const { state, engine } = newEngine();
    const report = engine.simulateOffline(state, 24 * 60 * 60 * 1000);
    expect(report.tickLengthUsed).toBe(1000);
  });

  it("restores original tickLength after simulation", () => {
    const { state, engine } = newEngine();

    engine.simulateOffline(state, 60 * 60 * 1000); // uses 1000ms internally

    const initialTicks = state.stats.ticks;
    const smallAdvanceMs = TICK_MS_INTERVAL * 5;
    engine.advance(state, smallAdvanceMs);
    expect(state.stats.ticks).toBe(initialTicks + 5);
  });

  it("durationMs respects cap when requested > 24h", () => {
    const { state, engine } = newEngine();
    const report = engine.simulateOffline(state, 30 * 24 * 60 * 60 * 1000);

    expect(report.durationMs).toBe(24 * 60 * 60 * 1000);
    expect(report.durationCapped).toBe(true);
  });

  it("ticksRun calculation: floor(durationMs / tickLengthUsed)", () => {
    const { state, engine } = newEngine();
    const report = engine.simulateOffline(state, 100_000); // uses 250ms (< 1h)

    expect(report.ticksRun).toBe(Math.floor(100_000 / 250));
  });
});
