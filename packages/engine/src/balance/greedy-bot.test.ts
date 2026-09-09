import { describe, expect, it } from "vitest";

import { silentLogger } from "../core/di/defaults";
import { Engine } from "../core/engine";
import type { Currency, Prestige, Producer, Upgrade } from "../models/base";
import { ScaleOn, ScalingMethod } from "../models/base";
import { NR } from "../nums";
import { createInitialState } from "../state";
import type { GameState } from "../state";
import { MockTimeProvider } from "../testing/MockTimeProvider";
import { GreedyBot } from "./greedy-bot";
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
