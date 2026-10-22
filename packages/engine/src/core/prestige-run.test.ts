import { describe, expect, it } from "vitest";

import type { Currency, GrowthFunction, Prestige } from "../models/base";
import { ScaleOn, ScalingMethod } from "../models/base";
import { N, NR } from "../nums";
import { type GameState, createInitialState } from "../state";
import { Engine } from "./engine";
import { advancePrestigeRuns, continuousPrestigeGain, prestigeRunRate, prestigesRestartedBy, rateRulePrestige } from "./prestige-run";

const IDENTITY: GrowthFunction = { base: NR(0), coeff: NR(1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self };
const currency = (code: string, amount: number, extra: Partial<Currency> = {}): Currency => ({ code, name: code, amount: NR(amount), ...extra });
const prestige = (code: string, currencyCode: string, source = "one"): Prestige => ({
  code,
  currencyCode,
  source: { kind: "currency", code: source, path: "amount" },
  target: { kind: "currency", code: currencyCode, path: "amount" },
  func: IDENTITY,
  effects: [],
});

function makeState(): GameState {
  return {
    ...createInitialState(),
    currencies: [currency("one", 0, { resetsOn: ["frag"] }), currency("if", 0, { earned: NR(0), resetsOn: ["comp"] }), currency("cocoon", 0, { earned: NR(0) })],
    prestiges: [prestige("frag", "if"), prestige("comp", "cocoon", "if")],
  };
}

const MIN = 60_000;

describe("continuousPrestigeGain", () => {
  it("is raw·gainMult without flooring, 0 below raw 1", () => {
    const engine = new Engine();
    const state = makeState();
    state.currencies[1]!.gainMult = NR(1.5);
    state.currencies[0]!.amount = NR(0.9);
    expect(continuousPrestigeGain(engine, state, state.prestiges[0]!).toNumber()).toBe(0);
    state.currencies[0]!.amount = NR(3);
    expect(continuousPrestigeGain(engine, state, state.prestiges[0]!).toNumber()).toBeCloseTo(4.5, 10);
  });
});

describe("prestigeRunRate", () => {
  it("is (continuous gain + earned − earnedAtStart) per minute", () => {
    const engine = new Engine();
    const state = makeState();
    state.currencies[0]!.amount = NR(10);
    advancePrestigeRuns(engine, state, 2 * MIN);
    expect(prestigeRunRate(engine, state, state.prestiges[0]!).toNumber()).toBeCloseTo(5, 10);
    state.currencies[1]!.earned = NR(4);
    expect(prestigeRunRate(engine, state, state.prestiges[0]!).toNumber()).toBeCloseTo(7, 10);
  });

  it("is 0 for a run that has not started", () => {
    const engine = new Engine();
    const state = makeState();
    state.currencies[0]!.amount = NR(10);
    expect(prestigeRunRate(engine, state, state.prestiges[0]!).toNumber()).toBe(0);
  });

  it("creates the run lazily with earnedAtStart = current earned", () => {
    const engine = new Engine();
    const state = makeState();
    state.currencies[1]!.earned = NR(7);
    expect(state.prestigeRuns).toBeUndefined();
    advancePrestigeRuns(engine, state, 1000);
    expect(state.prestigeRuns!.frag!.elapsedMs).toBe(1000);
    expect(N(state.prestigeRuns!.frag!.earnedAtStart).toNumber()).toBe(7);
  });

  it("is 0 when the source is not finite", () => {
    const engine = new Engine();
    const state = makeState();
    state.currencies[0]!.amount = NR(Infinity);
    advancePrestigeRuns(engine, state, MIN);
    expect(prestigeRunRate(engine, state, state.prestiges[0]!).toNumber()).toBe(0);
  });
});

describe("rateRulePrestige and peak", () => {
  it("tracks the peak after the minimum run time and fires when the rate falls to 95% of it", () => {
    const engine = new Engine();
    const state = makeState();
    const frag = state.prestiges[0]!;
    state.currencies[0]!.amount = NR(100);
    advancePrestigeRuns(engine, state, 30_000);
    expect(N(state.prestigeRuns!.frag!.peakRate).toNumber()).toBe(0);
    expect(rateRulePrestige(engine, state, frag)).toBe(false);

    advancePrestigeRuns(engine, state, 30_000); // 1 min, rate 100/min -> peak
    expect(N(state.prestigeRuns!.frag!.peakRate).toNumber()).toBeCloseTo(100, 6);
    expect(rateRulePrestige(engine, state, frag)).toBe(false);

    state.currencies[0]!.amount = NR(150); // still climbing
    advancePrestigeRuns(engine, state, MIN); // 2 min -> 75/min < peak? peak stays 100
    expect(rateRulePrestige(engine, state, frag)).toBe(true);
  });

  it("does not fire below minRunMs, without gain, or when the rate holds", () => {
    const engine = new Engine();
    const state = makeState();
    const frag = state.prestiges[0]!;
    state.currencies[0]!.amount = NR(100);
    advancePrestigeRuns(engine, state, MIN);
    expect(rateRulePrestige(engine, state, frag, { minRunMs: 5 * MIN })).toBe(false);
    state.currencies[0]!.amount = NR(0);
    expect(rateRulePrestige(engine, state, frag, { drop: 2 })).toBe(false);
    state.currencies[0]!.amount = NR(100);
    expect(rateRulePrestige(engine, state, frag)).toBe(false);
  });
});

describe("performPrestige resets the run clocks", () => {
  it("restarts the performed prestige and any prestige whose currency it resets, with earned post-reset", () => {
    const engine = new Engine();
    const state = makeState();
    state.currencies[1]!.resetsEarnedOn = ["comp"];
    state.currencies[0]!.amount = NR(50);
    advancePrestigeRuns(engine, state, 5 * MIN);
    expect(state.prestigeRuns!.comp!.elapsedMs).toBe(5 * MIN);

    // comp resets `if` (amount) and its earned; the frag run is restarted by the cascade (if is frag's currency)
    state.currencies[1]!.amount = NR(9);
    expect(engine.performPrestige(state, state.prestiges[1]!)).toBe(true);
    expect(N(state.currencies[1]!.earned ?? 0).toNumber()).toBe(0);
    expect(state.prestigeRuns!.comp!.elapsedMs).toBe(0);
    expect(state.prestigeRuns!.frag!.elapsedMs).toBe(0);
    expect(N(state.prestigeRuns!.frag!.earnedAtStart).toNumber()).toBe(0);
    expect(N(state.prestigeRuns!.comp!.peakRate).toNumber()).toBe(0);
  });

  it("performing frag restarts frag but not comp", () => {
    const engine = new Engine();
    const state = makeState();
    state.currencies[0]!.amount = NR(50);
    advancePrestigeRuns(engine, state, 3 * MIN);
    engine.performPrestige(state, state.prestiges[0]!);
    expect(state.prestigeRuns!.frag!.elapsedMs).toBe(0);
    expect(N(state.prestigeRuns!.frag!.earnedAtStart).toNumber()).toBe(50);
    expect(state.prestigeRuns!.comp!.elapsedMs).toBe(3 * MIN);
  });

  it("prestigesRestartedBy names the cascade the run clocks follow", () => {
    const state = makeState();
    expect(prestigesRestartedBy(state, "frag")).toEqual(["frag"]);
    expect(prestigesRestartedBy(state, "comp").sort()).toEqual(["comp", "frag"]);
  });

  it("the Automation stage advances the clock each tick", () => {
    const engine = new Engine();
    const state = makeState();
    engine.advance(state, 5000);
    expect(state.prestigeRuns!.frag!.elapsedMs).toBeGreaterThan(0);
  });
});
