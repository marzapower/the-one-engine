import { describe, expect, it } from "vitest";

import { silentLogger } from "../core/di/defaults";
import { Engine } from "../core/engine";
import type { Currency, Prestige, Producer, Upgrade } from "../models/base";
import { ScaleOn, ScalingMethod } from "../models/base";
import { NR } from "../nums";
import { createInitialState } from "../state";
import type { GameState } from "../state";
import { MockTimeProvider } from "../testing/MockTimeProvider";
import { GREEDY_DEFAULTS, GreedyBot } from "./greedy-bot";
import type { BotContext } from "./types";

function baseState(overrides: Partial<GameState> = {}): GameState {
  return { ...createInitialState(), ...overrides };
}

const linearScaling = (base: number, coeff: number) => ({
  base: NR(base),
  coeff: NR(coeff),
  func: ScalingMethod.Linear,
  scaleOn: ScaleOn.self,
});

function producer(code: string, persec: number, costBase: number, currencyCode = "primary"): Producer {
  return {
    code,
    name: code,
    currencyCode,
    amount: NR(0),
    bought: NR(0),
    produces: [{ code: "primary", persec: NR(persec) }],
    scaling: linearScaling(costBase, 0), // fixed cost per unit (coeff 0), for deterministic tests
  };
}

// These fixtures model a game whose declared primary currency is "primary"
// (Currency.primary — the anchor of the bot's whole value model).
function currency(code: string, amount: number, persecDelta?: number): Currency {
  return { code, name: code, primary: code === "primary", amount: NR(amount), persecDelta: persecDelta !== undefined ? NR(persecDelta) : undefined };
}

function newEngine(): Engine {
  return new Engine(250, { time: new MockTimeProvider(250), logger: silentLogger });
}

// decide() only reads ctx.state, ctx.engine and ctx.tSimMs.
function ctxFor(state: GameState, tSimMs = 0): BotContext {
  return { state, engine: newEngine(), tSimMs };
}

describe("GreedyBot", () => {
  it("buys the producer with the better payback (value/cost) when budget only covers one", () => {
    // A: persec=1, cost=10  -> ratio = H/10
    // B: persec=5, cost=20  -> ratio = H/4  (better)
    const state = baseState({
      producers: [producer("A", 1, 10), producer("B", 5, 20)],
      currencies: [currency("primary", 25)],
    });

    const bot = new GreedyBot();
    const intents = bot.decide(ctxFor(state));

    expect(intents).toEqual([{ kind: "buyProducer", code: "B", amount: 1 }]);
  });

  it("returns [] when broke (no currency to spend)", () => {
    const state = baseState({
      producers: [producer("A", 1, 10)],
      currencies: [currency("primary", 0)],
    });

    const bot = new GreedyBot();
    expect(bot.decide(ctxFor(state))).toEqual([]);
  });

  it("buys a mult upgrade on primary.persecDelta up to its max when it's the only candidate", () => {
    const upgrade: Upgrade = {
      code: "u1",
      name: "u1",
      currencyCode: "primary",
      amount: NR(1),
      bought: NR(0),
      scaling: linearScaling(50, 0), // fixed cost 50/purchase
      max: NR(3),
      effects: [
        {
          stage: 0,
          target: { kind: "currency", code: "primary", path: "persecDelta" },
          type: "mult",
          func: { base: NR(1), coeff: NR(0.5), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
        },
      ],
    };

    const state = baseState({
      upgrades: [upgrade],
      currencies: [currency("primary", 1000, 10)],
    });

    const bot = new GreedyBot();
    const intents = bot.decide(ctxFor(state));

    expect(intents).toEqual([
      { kind: "buyUpgrade", code: "u1" },
      { kind: "buyUpgrade", code: "u1" },
      { kind: "buyUpgrade", code: "u1" },
    ]);
  });

  it("triggers prestige-only intent when the compound multiplier gain clears the ratio bar", () => {
    const prestige: Prestige = {
      code: "convert",
      currencyCode: "prestige",
      source: { kind: "currency", code: "primary", path: "amount" },
      target: { kind: "currency", code: "prestige", path: "amount" },
      func: { base: NR(0), coeff: NR(1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self }, // gain = source amount
      effects: [
        {
          stage: 0,
          target: { kind: "currency", code: "primary", path: "persecDelta" },
          type: "mult",
          func: { base: NR(1), coeff: NR(0.01), func: ScalingMethod.Linear, scaleOn: ScaleOn.self }, // 1 + 0.01*prestige
        },
      ],
    };

    const state = baseState({
      // A cheap, obviously-affordable producer is present to prove prestige wins over buying.
      producers: [producer("A", 1, 10)],
      currencies: [currency("primary", 1000, 10), currency("prestige", 10)],
      prestiges: [prestige],
    });

    // gain = 1000 (source "primary" amount, func is identity)
    // m  = 1 + 0.01*10   = 1.1
    // m' = 1 + 0.01*1010 = 11.1
    // ratio = 11.1 / 1.1 ≈ 10.09 >= 1.5
    const bot = new GreedyBot();
    const intents = bot.decide(ctxFor(state));

    expect(intents).toEqual([{ kind: "prestige", code: "convert" }]);
  });

  it("does not misfire a worthless stall prestige right after a ratio-triggered prestige", () => {
    // "convert" delivers gain = source primary amount 1:1, and drives a mult
    // effect m = 1 + drive (steep, so a modest gain still clears the ratio
    // bar via m'/m without needing an enormous absolute gain).
    const prestige: Prestige = {
      code: "convert",
      currencyCode: "prestige",
      source: { kind: "currency", code: "primary", path: "amount" },
      target: { kind: "currency", code: "prestige", path: "amount" },
      func: { base: NR(0), coeff: NR(1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
      effects: [
        {
          stage: 0,
          target: { kind: "currency", code: "primary", path: "persecDelta" },
          type: "mult",
          func: { base: NR(1), coeff: NR(1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self }, // 1 + 1*drive
        },
      ],
    };

    const bot = new GreedyBot({ stallPrestigeAfterMs: 5_000 });

    // Call 1: primary is high, ratio prestige clears (m=1+10=11, m'=1+1010=1011, ratio≈92).
    // This also seeds the progress peak at log10(1000) = 3.
    const stateBeforePrestige = baseState({
      currencies: [currency("primary", 1000, 10), currency("prestige", 10)],
      prestiges: [prestige],
    });
    const firstIntents = bot.decide(ctxFor(stateBeforePrestige, 0));
    expect(firstIntents).toEqual([{ kind: "prestige", code: "convert" }]);

    // Call 2, just past stallPrestigeAfterMs: the ratio prestige reset primary
    // far below the recorded peak (5 << 1000), so with the bug the stale
    // peak/clock reads as "no progress for stallPrestigeAfterMs" and misfires
    // a near-worthless stall prestige (gain=5) — even though the ratio bar
    // itself correctly does NOT clear here (driveBefore=1010 is already
    // huge, so m'/m ≈ 1016/1011 << 1.5).
    const stateAfterPrestige = baseState({
      currencies: [currency("primary", 5, 10), currency("prestige", 1010)],
      prestiges: [prestige],
    });
    const secondIntents = bot.decide(ctxFor(stateAfterPrestige, 5_001));

    expect(secondIntents).toEqual([]);
  });

  it("does not trigger prestige when the ratio bar isn't cleared, and buys instead", () => {
    const prestige: Prestige = {
      code: "convert",
      currencyCode: "prestige",
      source: { kind: "currency", code: "primary", path: "amount" },
      target: { kind: "currency", code: "prestige", path: "amount" },
      func: { base: NR(0), coeff: NR(0.0001), func: ScalingMethod.Linear, scaleOn: ScaleOn.self }, // tiny gain
      effects: [
        {
          stage: 0,
          target: { kind: "currency", code: "primary", path: "persecDelta" },
          type: "mult",
          func: { base: NR(1), coeff: NR(0.01), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
        },
      ],
    };

    const state = baseState({
      producers: [producer("A", 1, 10)],
      // Budget covers exactly one unit of A (cost 10), so the buy list is a single intent.
      currencies: [currency("primary", 15, 10), currency("prestige", 10)],
      prestiges: [prestige],
    });

    const bot = new GreedyBot();
    const intents = bot.decide(ctxFor(state));

    expect(intents).toEqual([{ kind: "buyProducer", code: "A", amount: 1 }]);
  });
});

describe("GreedyBot visit gate (minPurchaseImpact)", () => {
  // primary persecDelta 100 over the default 600 s horizon = 60000: a 1% bar is 600.
  const gate = { minPurchaseImpact: 0.01 };

  /** Producer worth 600 (1%, relevant) or 60 (0.1%, irrelevant) at the 600 s horizon. */
  const relevant = (code: string, cost: number) => producer(code, 1, cost);
  const crumb = (code: string, cost: number) => producer(code, 0.1, cost);

  it("(a) buys nothing when everything affordable is irrelevant", () => {
    const state = baseState({ producers: [crumb("C", 10)], currencies: [currency("primary", 1000, 100)] });

    expect(new GreedyBot(gate).decide(ctxFor(state))).toEqual([]);
    // The ungated bot does buy them.
    expect(new GreedyBot().decide(ctxFor(state)).length).toBeGreaterThan(0);
  });

  it("(b) plans the relevant candidate FIRST even when crumbs in the same pool are more efficient", () => {
    // R: value 600, cost 100 -> efficiency 6.  C: value 60, cost 0.5 -> efficiency 120.
    const state = baseState({ producers: [relevant("R", 100), crumb("C", 0.5)], currencies: [currency("primary", 150, 100)] });

    const gated = new GreedyBot(gate).decide(ctxFor(state));
    expect(gated[0]).toEqual({ kind: "buyProducer", code: "R", amount: 1 });
    expect(gated.filter((i) => i.kind === "buyProducer" && i.code === "R")).toHaveLength(1);
    // The rest of the budget still goes to the crumbs (the visit buys as usual).
    expect(gated.length).toBeGreaterThan(1);

    expect(new GreedyBot().decide(ctxFor(state))[0]).toEqual({ kind: "buyProducer", code: "C", amount: 1 });
  });

  it("(c) a producer-paid upgrade with negative net value does not open the gate; a positive one does", () => {
    const paidIn = (cost: number): Upgrade => ({
      code: "u",
      name: "u",
      currencyCode: "p1",
      amount: NR(0),
      bought: NR(0),
      scaling: linearScaling(cost, 0),
      effects: [{ stage: 0, target: { kind: "currency", code: "primary", path: "persecDelta" }, type: "mult", func: linearScaling(1, 0.5) }],
    });
    // p1 is unaffordable (cost 1e9); its 10 units are worth 600 each, the upgrade gains 0.5 x 10 x 600 = 3000.
    const p1: Producer = { ...producer("p1", 1, 1e9), amount: NR(10) };
    const stateWith = (cost: number) => baseState({ producers: [p1], upgrades: [paidIn(cost)], currencies: [currency("primary", 0, 10)] });

    expect(new GreedyBot(gate).decide(ctxFor(stateWith(10)))).toEqual([]); // burns 6000 for 3000
    const opened = new GreedyBot(gate).decide(ctxFor(stateWith(2)));
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.every((i) => i.kind === "buyUpgrade" && i.code === "u")).toBe(true);
  });

  it("(d) buys an isolated utility upgrade", () => {
    const utility: Upgrade = {
      code: "util",
      name: "util",
      currencyCode: "prestige",
      amount: NR(0),
      bought: NR(0),
      scaling: linearScaling(10, 0),
      effects: [{ stage: 0, target: { kind: "currency", code: "prestige", path: "capacityMult" }, type: "mult", func: linearScaling(1, 1) }],
    };
    const convert: Prestige = {
      code: "convert",
      currencyCode: "prestige",
      source: { kind: "currency", code: "primary", path: "amount" },
      target: { kind: "currency", code: "prestige", path: "amount" },
      func: linearScaling(0, 1),
      effects: [],
    };
    const state = baseState({
      producers: [crumb("C", 1e9)],
      upgrades: [utility],
      prestiges: [convert],
      currencies: [currency("primary", 0, 100), currency("prestige", 50)],
    });

    expect(new GreedyBot(gate).decide(ctxFor(state))).toEqual([
      { kind: "buyUpgrade", code: "util" },
      { kind: "buyUpgrade", code: "util" },
      { kind: "buyUpgrade", code: "util" },
      { kind: "buyUpgrade", code: "util" },
      { kind: "buyUpgrade", code: "util" },
    ]);
  });

  it("(e) without a prestige, makes a catch-up visit after maxWaitMs since the last purchase", () => {
    const bot = new GreedyBot({ ...gate, maxWaitMs: 60_000 });
    const state = () => baseState({ producers: [crumb("C", 10)], currencies: [currency("primary", 15, 100)] });

    expect(bot.decide(ctxFor(state(), 30_000))).toEqual([]);
    expect(bot.decide(ctxFor(state(), 60_000))).toEqual([{ kind: "buyProducer", code: "C", amount: 1 }]);
    // The visit reset the clock: no new catch-up right away.
    expect(bot.decide(ctxFor(state(), 65_000))).toEqual([]);
    expect(bot.decide(ctxFor(state(), 120_000))).toEqual([{ kind: "buyProducer", code: "C", amount: 1 }]);
  });

  it("(f) defaults are the gate off, and decisions equal an explicit threshold of 0", () => {
    expect(GREEDY_DEFAULTS.minPurchaseImpact).toBe(0);
    expect(GREEDY_DEFAULTS.maxWaitMs).toBe(Number.POSITIVE_INFINITY);

    const state = baseState({ producers: [crumb("C", 10), relevant("R", 100)], currencies: [currency("primary", 250, 100)] });
    const byDefault = new GreedyBot().decide(ctxFor(state));
    expect(byDefault.length).toBeGreaterThan(0);
    expect(new GreedyBot({ minPurchaseImpact: 0, maxWaitMs: 1 }).decide(ctxFor(state))).toEqual(byDefault);
  });

  it("rejects invalid gate options at construction and in setOptions", () => {
    for (const bad of [Number.NaN, -0.1, Number.POSITIVE_INFINITY]) {
      expect(() => new GreedyBot({ minPurchaseImpact: bad })).toThrow(/minImpact/);
    }
    expect(() => new GreedyBot({ horizonMs: 0 })).toThrow(/horizonMs/);
    expect(() => new GreedyBot({ maxWaitMs: Number.NaN })).toThrow(/maxWaitMs/);
    expect(() => new GreedyBot().setOptions({ minPurchaseImpact: -1 })).toThrow(/minImpact/);
    expect(() => new GreedyBot({ horizonMs: Number.POSITIVE_INFINITY })).toThrow(/horizonMs/);
  });

  it("leaves the options untouched when setOptions is rejected", () => {
    const state = baseState({ producers: [crumb("C", 10)], currencies: [currency("primary", 250, 100)] });
    const bot = new GreedyBot(gate);
    // The valid half (gate off) must not apply when the other half is invalid.
    expect(() => bot.setOptions({ minPurchaseImpact: 0, horizonMs: 0 })).toThrow(/horizonMs/);
    expect(bot.decide(ctxFor(state))).toEqual([]);
  });
});
