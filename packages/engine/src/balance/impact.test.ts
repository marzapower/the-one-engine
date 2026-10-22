import { describe, expect, it } from "vitest";

import { silentLogger } from "../core/di/defaults";
import { Engine } from "../core/engine";
import type { Currency, Prestige, Producer, Upgrade } from "../models/base";
import { ScaleOn, ScalingMethod } from "../models/base";
import { N, NR } from "../nums";
import { createInitialState } from "../state";
import type { GameState } from "../state";
import { MockTimeProvider } from "../testing/MockTimeProvider";
import { isMeaningfulValue, isWaiting, meaningfulPurchases, netPurchaseValue, prestigeWorthTaking } from "./impact";
import { anyActionAvailable } from "./queries";

const lin = (base: number, coeff: number) => ({ base: NR(base), coeff: NR(coeff), func: ScalingMethod.Linear, scaleOn: ScaleOn.self });

function newEngine(): Engine {
  return new Engine(250, { time: new MockTimeProvider(250), logger: silentLogger });
}

function currency(code: string, amount: number, persecDelta?: number): Currency {
  return { code, name: code, primary: code === "primary", amount: NR(amount), persecDelta: persecDelta !== undefined ? NR(persecDelta) : undefined };
}

/** Constant-cost producer of the primary currency (coeff 0 keeps costs deterministic). */
function producer(code: string, persec: number, cost: number, opts: { amount?: number; currencyCode?: string } = {}): Producer {
  return {
    code,
    name: code,
    currencyCode: opts.currencyCode ?? "primary",
    amount: NR(opts.amount ?? 0),
    bought: NR(0),
    produces: [{ code: "primary", persec: NR(persec) }],
    scaling: lin(cost, 0),
  };
}

/** Constant-cost upgrade multiplying the primary production by `1 + 0.5 * bought`. */
function upgrade(code: string, cost: number, opts: { currencyCode?: string; amount?: number; max?: number } = {}): Upgrade {
  return {
    code,
    name: code,
    currencyCode: opts.currencyCode ?? "primary",
    amount: NR(opts.amount ?? 0),
    bought: NR(0),
    max: opts.max === undefined ? undefined : NR(opts.max),
    scaling: lin(cost, 0),
    effects: [{ stage: 0, target: { kind: "currency", code: "primary", path: "persecDelta" }, type: "mult", func: lin(1, 0.5) }],
  };
}

function prestigeOf(gainCoeff: number, effectCoeff: number): Prestige {
  return {
    code: "convert",
    currencyCode: "prestige",
    source: { kind: "currency", code: "primary", path: "amount" },
    target: { kind: "currency", code: "prestige", path: "amount" },
    func: lin(0, gainCoeff),
    effects: [{ stage: 0, target: { kind: "currency", code: "primary", path: "persecDelta" }, type: "mult", func: lin(1, effectCoeff) }],
  };
}

/** Indexed access that fails loudly instead of yielding undefined (noUncheckedIndexedAccess). */
function at<T>(items: T[], index = 0): T {
  const item = items[index];
  if (item === undefined) throw new Error(`fixture index ${index} missing`);
  return item;
}

function stateOf(overrides: Partial<GameState>): GameState {
  return { ...createInitialState(), ...overrides };
}

const H = 600_000; // 600 s

describe("isMeaningfulValue", () => {
  // persec 100 over 10 s = 1000 -> a 1% bar is 10.
  const state = stateOf({ currencies: [currency("primary", 0, 100)] });

  it("is false below the bar, true at it and above it", () => {
    expect(isMeaningfulValue(state, N(9.99), 0.01, 10_000)).toBe(false);
    expect(isMeaningfulValue(state, N(10), 0.01, 10_000)).toBe(true);
    expect(isMeaningfulValue(state, N(11), 0.01, 10_000)).toBe(true);
  });

  it("accepts any positive value when the primary production is not positive", () => {
    const idle = stateOf({ currencies: [currency("primary", 0, 0)] });
    expect(isMeaningfulValue(idle, N(0.0001), 0.5, 10_000)).toBe(true);
    expect(isMeaningfulValue(idle, N(0), 0.5, 10_000)).toBe(false);
  });

  it("with a zero threshold accepts any non-negative value", () => {
    expect(isMeaningfulValue(state, N(0.0001), 0, 10_000)).toBe(true);
  });
});

describe("netPurchaseValue", () => {
  // p1 yields 1/s: one unit is worth 600 over 600 s. persec 10 -> a +50% upgrade is worth 3000.
  const base = (upgradeCost: number) => {
    const p1 = producer("p1", 1, 1e9, { amount: 10 });
    const u = upgrade("u", upgradeCost, { currencyCode: "p1" });
    return { state: stateOf({ currencies: [currency("primary", 0, 10)], producers: [p1], upgrades: [u] }), u };
  };

  it("returns null for a producer-paid upgrade whose units are worth more than the gain", () => {
    const { state, u } = base(10); // burns 10 units worth 6000 for a 3000 gain
    expect(netPurchaseValue(newEngine(), state, { kind: "upgrade", upgrade: u }, N(10), H)).toBeNull();
  });

  it("returns value minus the value of the burned units when positive", () => {
    const { state, u } = base(2); // 3000 - 2 x 600
    expect(netPurchaseValue(newEngine(), state, { kind: "upgrade", upgrade: u }, N(2), H)?.toNumber()).toBeCloseTo(1800, 6);
  });

  it("returns the plain value for producers and currency-paid upgrades, and null without value", () => {
    const state = stateOf({ currencies: [currency("primary", 0, 10)], producers: [producer("p1", 1, 5)], upgrades: [upgrade("u", 5)] });
    const engine = newEngine();
    expect(netPurchaseValue(engine, state, { kind: "producer", producer: at(state.producers) }, N(5), H)?.toNumber()).toBeCloseTo(600, 6);
    expect(netPurchaseValue(engine, state, { kind: "upgrade", upgrade: at(state.upgrades) }, N(5), H)?.toNumber()).toBeCloseTo(3000, 6);
    expect(netPurchaseValue(engine, state, { kind: "producer", producer: at(state.producers) }, N(0), H)).toBeNull();
    const dead = stateOf({ currencies: [currency("primary", 0, 10)], producers: [{ ...producer("d", 1, 5), produces: [{ code: "nowhere", persec: NR(1) }] }] });
    expect(netPurchaseValue(engine, dead, { kind: "producer", producer: at(dead.producers) }, N(5), H)).toBeNull();
  });
});

describe("meaningfulPurchases", () => {
  it("checks affordability first: an unaffordable relevant candidate is not returned", () => {
    const state = stateOf({
      currencies: [currency("primary", 50, 100)],
      producers: [producer("cheap", 1, 10), producer("dear", 1, 1000)],
    });
    expect([...meaningfulPurchases(newEngine(), state, 0.001, H)]).toEqual(["producer:cheap"]);
  });

  it("checks affordability against a producer pool: an upgrade paid in units needs the units", () => {
    // +50% of persec 10 over 600 s = 3000, for 2 units worth 600 each: relevant when payable.
    const units = (amount: number) =>
      stateOf({ currencies: [currency("primary", 0, 10)], producers: [producer("p1", 1, 1e9, { amount })], upgrades: [upgrade("u", 2, { currencyCode: "p1" })] });
    expect([...meaningfulPurchases(newEngine(), units(10), 0.01, H)]).toEqual(["upgrade:u"]);
    expect(meaningfulPurchases(newEngine(), units(1), 0.01, H).size).toBe(0);
  });

  it("filters by impact: a purchase below the bar is left out", () => {
    // persec 100 x 600 s = 60000; 1% = 600. "big" is worth 600 (kept, equality), "small" 60.
    const state = stateOf({
      currencies: [currency("primary", 1000, 100)],
      producers: [producer("big", 1, 10), producer("small", 0.1, 10)],
    });
    expect([...meaningfulPurchases(newEngine(), state, 0.01, H)]).toEqual(["producer:big"]);
  });

  it("checks `max` against `amount`, like the harness", () => {
    const state = stateOf({
      currencies: [currency("primary", 1000, 10)],
      upgrades: [upgrade("capped", 5, { amount: 1, max: 1 }), upgrade("open", 5, { amount: 0, max: 1 })],
    });
    expect([...meaningfulPurchases(newEngine(), state, 0, H)]).toEqual(["upgrade:open"]);
  });

  it("always includes an affordable utility upgrade, whatever the threshold", () => {
    const utility: Upgrade = {
      ...upgrade("util", 10, { currencyCode: "prestige" }),
      effects: [{ stage: 0, target: { kind: "currency", code: "prestige", path: "capacityMult" }, type: "mult", func: lin(1, 1) }],
    };
    const state = stateOf({
      currencies: [currency("primary", 0, 100), currency("prestige", 100)],
      prestiges: [prestigeOf(0, 0.01)],
      upgrades: [utility],
    });
    expect([...meaningfulPurchases(newEngine(), state, 0.9, H)]).toEqual(["upgrade:util"]);
    // Not affordable -> not available.
    const poor = stateOf({ ...state, currencies: [currency("primary", 0, 100), currency("prestige", 5)] });
    expect(meaningfulPurchases(newEngine(), poor, 0.9, H).size).toBe(0);
  });
});

describe("prestigeWorthTaking", () => {
  it("ignores a prestige with positive gain but a low ratio, and picks one at or above the ratio", () => {
    const low = stateOf({ currencies: [currency("primary", 1000, 10), currency("prestige", 10)], prestiges: [prestigeOf(0.002, 0.01)] });
    const high = stateOf({ currencies: [currency("primary", 1000, 10), currency("prestige", 10)], prestiges: [prestigeOf(1, 0.01)] });
    expect(newEngine().prestigeGain(low, at(low.prestiges)).gt(0)).toBe(true);
    expect(prestigeWorthTaking(newEngine(), low, 1.5)).toBeNull();
    expect(prestigeWorthTaking(newEngine(), high, 1.5)?.code).toBe("convert");
  });
});

describe("isWaiting", () => {
  const states: GameState[] = [
    stateOf({ currencies: [currency("primary", 0, 10)], producers: [producer("a", 1, 10)] }), // broke
    stateOf({ currencies: [currency("primary", 100, 10)], producers: [producer("a", 1, 10)] }), // affordable
    stateOf({ currencies: [currency("primary", 100, 10)], producers: [producer("a", 0.001, 10)] }), // affordable but irrelevant
    stateOf({ currencies: [currency("primary", 5, 10), currency("prestige", 0)], producers: [producer("a", 1, 10)], prestiges: [prestigeOf(1, 0.01)] }), // only a prestige
    stateOf({ currencies: [currency("primary", 100, 10)], upgrades: [upgrade("u", 5, { amount: 1, max: 1 })] }), // maxed upgrade
  ];

  it("with minImpact 0 matches !anyActionAvailable on several states", () => {
    const engine = newEngine();
    for (const state of states) {
      expect(isWaiting(engine, state, { minImpact: 0, horizonMs: H, prestigeRatio: 1.5 })).toBe(!anyActionAvailable(engine, state));
    }
  });

  it("with minImpact > 0 treats an irrelevant purchase as waiting, a relevant one as not", () => {
    const opts = { minImpact: 0.01, horizonMs: H, prestigeRatio: 1.5 };
    expect(isWaiting(newEngine(), at(states, 2), opts)).toBe(true);
    expect(isWaiting(newEngine(), at(states, 1), opts)).toBe(false);
  });

  it("with minImpact > 0 ignores a low-ratio prestige and counts one at the ratio", () => {
    const opts = { minImpact: 0.01, horizonMs: H, prestigeRatio: 1.5 };
    const quiet = { currencies: [currency("primary", 1000, 10), currency("prestige", 10)], producers: [producer("a", 1, 1e9)] };
    const low = stateOf({ ...quiet, prestiges: [prestigeOf(0.002, 0.01)] });
    const high = stateOf({ ...quiet, prestiges: [prestigeOf(1, 0.01)] });
    expect(isWaiting(newEngine(), low, opts)).toBe(true);
    expect(isWaiting(newEngine(), high, opts)).toBe(false);
    // The historical metric still sees any positive gain as an action.
    expect(isWaiting(newEngine(), low, { ...opts, minImpact: 0 })).toBe(false);
  });
});
