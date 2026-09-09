import { describe, expect, it } from "vitest";

import { Engine } from "../core/engine";
import type { Currency, Producer } from "../models/base";
import { ScaleOn, ScalingMethod } from "../models/base";
import { N, NR } from "../nums";
import { type GameState, createInitialState } from "../state";
import { MockStateAdapter } from "./MockStateAdapter";
import { MockTimeProvider } from "./MockTimeProvider";
import { ScenarioRunner } from "./ScenarioRunner";

function createTestGameState(): GameState {
  const currency: Currency = {
    code: "one",
    name: "One",
    amount: NR(1000),
  };

  const producer: Producer = {
    code: "e1",
    name: "Producer",
    currencyCode: "one",
    amount: NR(0),
    bought: NR(0),
    produces: [{ code: "one", persec: NR(12) }],
    scaling: {
      base: NR(10),
      coeff: NR(1.2),
      scaleOn: ScaleOn.self,
      func: ScalingMethod.Geometric,
    },
  };

  return {
    ...createInitialState(),
    producers: [producer],
    currencies: [currency],
  };
}

function newRunner() {
  const state = createTestGameState();
  const time = new MockTimeProvider(16);
  const adapter = new MockStateAdapter();
  const engine = new Engine(16, { time, state: adapter });
  return { state, engine, adapter, runner: new ScenarioRunner(state, engine, adapter) };
}

describe("ScenarioRunner", () => {
  it("advance: progresses ticks deterministically", () => {
    const { runner, state } = newRunner();
    runner.advance(1600); // 100 ticks of 16ms
    expect(state.stats.ticks).toBe(100);
  });

  it("buy: reduces currency and increases producer.bought", () => {
    const { runner, state } = newRunner();
    const currency = state.currencies[0];
    const producer = state.producers[0];
    if (!currency || !producer) throw new Error("fixture mismatch");
    const beforeCurrency = N(currency.amount).toNumber();
    runner.buy("e1", 3);
    expect(N(producer.bought).toNumber()).toBe(3);
    expect(N(currency.amount).toNumber()).toBeLessThan(beforeCurrency);
  });

  it("mutations: adapter logs every mutation", () => {
    const { runner, adapter } = newRunner();
    adapter.clearMutations();
    runner.advance(160); // 10 ticks → many mutations (setPersecDelta, addPersecDelta, incrementAmount)
    expect(runner.mutations().length).toBeGreaterThan(0);
  });

  it("clearMutations empties the log", () => {
    const { runner, adapter } = newRunner();
    runner.advance(160);
    expect(runner.mutations().length).toBeGreaterThan(0);
    adapter.clearMutations();
    expect(runner.mutations().length).toBe(0);
  });

  it("snapshot: two identical runs produce equal snapshots", () => {
    const a = newRunner();
    const b = newRunner();
    a.runner.advance(1600);
    b.runner.advance(1600);
    const snapA = a.runner.snapshot();
    const snapB = b.runner.snapshot();
    // Stage metrics timing varies per-run; compare gameplay-relevant fields only
    expect(snapA.producers).toEqual(snapB.producers);
    expect(snapA.currencies).toEqual(snapB.currencies);
    expect(snapA.stats.ticks).toEqual(snapB.stats.ticks);
  });

  it("throws on unknown producer code", () => {
    const { runner } = newRunner();
    expect(() => runner.buy("xyz", 1)).toThrow("Producer not found: xyz");
  });

  it("throws on unknown prestige code", () => {
    const { runner } = newRunner();
    expect(() => runner.resetPrestige("xyz")).toThrow("Prestige not found: xyz");
  });

  it("fluent API returns this", () => {
    const { runner } = newRunner();
    expect(runner.advance(16).advance(16)).toBe(runner);
  });
});
