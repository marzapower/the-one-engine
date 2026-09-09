import { describe, expect, it } from "vitest";

import { silentLogger } from "../core/di/defaults";
import { Engine } from "../core/engine";
import type { Currency, Producer, Upgrade } from "../models/base";
import { ScaleOn, ScalingMethod } from "../models/base";
import { NR } from "../nums";
import { createInitialState } from "../state";
import type { GameState } from "../state";
import { MockTimeProvider } from "../testing/MockTimeProvider";
import { horizonValueOfProducerUnit, horizonValueOfUpgrade, resolveChainToPrimary } from "./horizon-value";

/** Minimal, otherwise-empty GameState — only producers/currencies/upgrades/prestiges vary per test. */
function baseState(overrides: Partial<GameState> = {}): GameState {
  return { ...createInitialState(), ...overrides };
}

function newEngine(): Engine {
  return new Engine(250, { time: new MockTimeProvider(250), logger: silentLogger });
}

const linearScaling = (base: number, coeff: number) => ({
  base: NR(base),
  coeff: NR(coeff),
  func: ScalingMethod.Linear,
  scaleOn: ScaleOn.self,
});

// These fixtures model a game whose declared primary currency is "primary"
// (Currency.primary — the anchor the chains must resolve to).
const currency = (code: string, amount: number, persecDelta?: number): Currency => ({
  code,
  name: code,
  primary: code === "primary",
  amount: NR(amount),
  persecDelta: persecDelta !== undefined ? NR(persecDelta) : undefined,
});

function producer(code: string, producesCode: string, persec: number, currencyCode = "primary"): Producer {
  return {
    code,
    name: code,
    currencyCode,
    amount: NR(0),
    bought: NR(0),
    produces: [{ code: producesCode, persec: NR(persec) }],
    scaling: linearScaling(10, 0),
  };
}

describe("resolveChainToPrimary / horizonValueOfProducerUnit", () => {
  it("2-tier chain: p2 -> p1 -> primary, value = p1*p2*H^2/2", () => {
    const p1 = 3; // p1 -> primary
    const p2 = 5; // p2 -> p1
    const state = baseState({
      producers: [producer("p1", "primary", p1), producer("p2", "p1", p2)],
      currencies: [currency("primary", 0)],
    });

    const chain = resolveChainToPrimary(state, "p2");
    if (!chain) throw new Error("expected chain to resolve to primary");
    expect(chain.depth).toBe(2);
    expect(chain.rateProduct.toNumber()).toBeCloseTo(p1 * p2, 9);

    const horizonMs = 60_000; // 60s
    const H = horizonMs / 1000;
    const expected = (p1 * p2 * H ** 2) / 2;

    const engine = newEngine();
    const value = horizonValueOfProducerUnit(engine, state, "p2", horizonMs);
    expect(value.toNumber()).toBeCloseTo(expected, 6);
  });

  it("1-tier chain: p1 -> primary, value = p1*H", () => {
    const p1 = 4;
    const state = baseState({ producers: [producer("p1", "primary", p1)], currencies: [currency("primary", 0)] });
    const horizonMs = 10_000;

    const engine = newEngine();
    const value = horizonValueOfProducerUnit(engine, state, "p1", horizonMs);
    expect(value.toNumber()).toBeCloseTo(p1 * (horizonMs / 1000), 9);
  });

  it("producer whose chain terminates on a non-primary currency has value 0", () => {
    const state = baseState({ producers: [producer("side", "elsewhere", 100)] });

    expect(resolveChainToPrimary(state, "side")).toBeNull();
    expect(horizonValueOfProducerUnit(newEngine(), state, "side", 600_000).toNumber()).toBe(0);
  });

  it("unknown producer code resolves to null / 0", () => {
    const state = baseState();
    expect(resolveChainToPrimary(state, "nope")).toBeNull();
    expect(horizonValueOfProducerUnit(newEngine(), state, "nope", 600_000).toNumber()).toBe(0);
  });

  it("dangling chain (points at a code that is neither a producer nor the primary) resolves to null", () => {
    // p5 claims to feed "p4", but no producer with code "p4" exists.
    const state = baseState({ producers: [producer("p5", "p4", 2)] });
    expect(resolveChainToPrimary(state, "p5")).toBeNull();
  });
});

describe("horizonValueOfUpgrade", () => {
  function upgrade(bought: number, effects: Upgrade["effects"], max?: number): Upgrade {
    return {
      code: "u1",
      name: "u1",
      currencyCode: "primary",
      amount: NR(1),
      bought: NR(bought),
      scaling: linearScaling(50, 0),
      effects,
      max: max !== undefined ? NR(max) : undefined,
    };
  }

  it("mult effect on primary.persecDelta: value = (f-1) * primaryPersecCurrent * H", () => {
    const primaryPersec = 10;
    const state = baseState({ currencies: [currency("primary", 1000, primaryPersec)] });
    const engine = newEngine();

    const bought = 0;
    const func = { base: NR(1), coeff: NR(0.5), func: ScalingMethod.Linear, scaleOn: ScaleOn.self };
    const u = upgrade(bought, [{ stage: 0, target: { kind: "currency", code: "primary", path: "persecDelta" }, type: "mult", func }]);

    const horizonMs = 600_000;
    const H = horizonMs / 1000;
    // denom = 1 + 0.5*0 = 1, numer = 1 + 0.5*1 = 1.5, f = 1.5
    const expected = (1.5 - 1) * primaryPersec * H;

    const value = horizonValueOfUpgrade(engine, state, u, horizonMs);
    expect(value.toNumber()).toBeCloseTo(expected, 6);
  });

  it("effect targeting a currency other than the primary contributes 0", () => {
    const state = baseState({ currencies: [currency("primary", 1000, 10), currency("time", 0, 0)] });
    const func = { base: NR(1), coeff: NR(0.5), func: ScalingMethod.Linear, scaleOn: ScaleOn.self };
    const u = upgrade(0, [{ stage: 0, target: { kind: "currency", code: "time", path: "persecDelta" }, type: "mult", func }]);

    expect(horizonValueOfUpgrade(newEngine(), state, u, 600_000).toNumber()).toBe(0);
  });

  it("mult effect with denom <= 0 is skipped (guard)", () => {
    const state = baseState({ currencies: [currency("primary", 1000, 10)] });
    // base=0, coeff=0 -> growth function is constantly 0 for any bought value.
    const func = { base: NR(0), coeff: NR(0), func: ScalingMethod.Linear, scaleOn: ScaleOn.self };
    const u = upgrade(0, [{ stage: 0, target: { kind: "currency", code: "primary", path: "persecDelta" }, type: "mult", func }]);

    expect(horizonValueOfUpgrade(newEngine(), state, u, 600_000).toNumber()).toBe(0);
  });

  it("mult effect on a producer's produces.*.persec whose chain reaches the primary is counted (approximated via current persec)", () => {
    const primaryPersec = 20;
    const state = baseState({
      producers: [producer("p1", "primary", 3)],
      currencies: [currency("primary", 1000, primaryPersec)],
    });
    const func = { base: NR(1), coeff: NR(1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self };
    const u = upgrade(0, [{ stage: 0, target: { kind: "producer", code: "p1", path: "produces.*.persec" }, type: "mult", func }]);

    const horizonMs = 600_000;
    const H = horizonMs / 1000;
    // denom = 1 + 1*0 = 1, numer = 1 + 1*1 = 2, f = 2
    const expected = (2 - 1) * primaryPersec * H;

    expect(horizonValueOfUpgrade(newEngine(), state, u, horizonMs).toNumber()).toBeCloseTo(expected, 6);
  });

  it("mult effect targeting a producer whose chain never reaches the primary contributes 0", () => {
    const state = baseState({
      producers: [producer("side", "elsewhere", 100)],
      currencies: [currency("primary", 1000, 10)],
    });
    const func = { base: NR(1), coeff: NR(1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self };
    const u = upgrade(0, [{ stage: 0, target: { kind: "producer", code: "side", path: "produces.*.persec" }, type: "mult", func }]);

    expect(horizonValueOfUpgrade(newEngine(), state, u, 600_000).toNumber()).toBe(0);
  });

  it("add effect on primary.persecDelta: value = delta * H", () => {
    const state = baseState({ currencies: [currency("primary", 1000, 10)] });
    const engine = newEngine();
    const func = { base: NR(2), coeff: NR(0), func: ScalingMethod.Linear, scaleOn: ScaleOn.self };
    const u = upgrade(3, [{ stage: 0, target: { kind: "currency", code: "primary", path: "persecDelta" }, type: "add", func }]);

    // before = after = 2 (coeff 0) -> delta = 0
    expect(horizonValueOfUpgrade(engine, state, u, 600_000).toNumber()).toBe(0);

    const funcGrowing = { base: NR(0), coeff: NR(1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self };
    const u2 = upgrade(3, [{ stage: 0, target: { kind: "currency", code: "primary", path: "persecDelta" }, type: "add", func: funcGrowing }]);
    const horizonMs = 100_000;
    const H = horizonMs / 1000;
    // before = 3, after = 4 -> delta = 1
    expect(horizonValueOfUpgrade(engine, state, u2, horizonMs).toNumber()).toBeCloseTo(1 * H, 6);
  });

  it("add effect on a producer's produces.*.persec is not modeled (contributes 0)", () => {
    const state = baseState({
      producers: [producer("p1", "primary", 3)],
      currencies: [currency("primary", 1000, 10)],
    });
    const func = { base: NR(0), coeff: NR(1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self };
    const u = upgrade(3, [{ stage: 0, target: { kind: "producer", code: "p1", path: "produces.*.persec" }, type: "add", func }]);

    expect(horizonValueOfUpgrade(newEngine(), state, u, 600_000).toNumber()).toBe(0);
  });

  it("a custom effect type contributes 0 (the value model cannot price it generically)", () => {
    const state = baseState({ currencies: [currency("primary", 1000, 10)] });
    const func = { base: NR(1), coeff: NR(0.5), func: ScalingMethod.Linear, scaleOn: ScaleOn.self };
    const u = upgrade(0, [{ stage: 0, target: { kind: "currency", code: "primary", path: "persecDelta" }, type: "custom-behavior", func }]);

    expect(horizonValueOfUpgrade(newEngine(), state, u, 600_000).toNumber()).toBe(0);
  });

  it("sums contributions across multiple effects", () => {
    const primaryPersec = 10;
    const state = baseState({ currencies: [currency("primary", 1000, primaryPersec)] });
    const engine = newEngine();
    const func = { base: NR(1), coeff: NR(0.5), func: ScalingMethod.Linear, scaleOn: ScaleOn.self };
    const u = upgrade(0, [
      { stage: 0, target: { kind: "currency", code: "primary", path: "persecDelta" }, type: "mult", func },
      { stage: 0, target: { kind: "currency", code: "primary", path: "persecDelta" }, type: "mult", func },
    ]);

    const horizonMs = 600_000;
    const H = horizonMs / 1000;
    const single = (1.5 - 1) * primaryPersec * H;

    expect(horizonValueOfUpgrade(engine, state, u, horizonMs).toNumber()).toBeCloseTo(single * 2, 6);
  });
});
