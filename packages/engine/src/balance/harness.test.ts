import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Currency, Prestige, Producer } from "../models/base";
import { ScaleOn, ScalingMethod } from "../models/base";
import { NR } from "../nums";
import { createInitialState } from "../state";
import type { GameState } from "../state";
import type { ResolvedClickable } from "./definition";
import { GreedyBot } from "./greedy-bot";
import { runBalanceSim } from "./harness";

const linearScaling = (base: number, coeff: number) => ({
  base: NR(base),
  coeff: NR(coeff),
  func: ScalingMethod.Linear,
  scaleOn: ScaleOn.self,
});

function tinyState(): GameState {
  const primary: Currency = { code: "primary", name: "Primary", primary: true, amount: NR(0), persecDelta: NR(0) };
  const prestigeCurrency: Currency = { code: "prestige", name: "Prestige", amount: NR(0), earned: NR(0) };

  const producer: Producer = {
    code: "p1",
    name: "Producer",
    currencyCode: "primary",
    amount: NR(0),
    bought: NR(0),
    produces: [{ code: "primary", persec: NR(1) }],
    scaling: linearScaling(5, 1.1),
  };

  const prestige: Prestige = {
    code: "convert",
    currencyCode: "prestige",
    source: { kind: "currency", code: "primary", path: "amount" },
    target: { kind: "currency", code: "prestige", path: "amount" },
    func: { base: NR(0), coeff: NR(1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
    effects: [],
  };

  return {
    ...createInitialState(),
    producers: [producer],
    currencies: [primary, prestigeCurrency],
    prestiges: [prestige],
  };
}

describe("runBalanceSim", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("produces milestones, series and purchaseRotation on a tiny scripted run", () => {
    const report = runBalanceSim({
      state: tinyState(),
      bot: new GreedyBot(),
      params: { durationMs: 5_000, sampleIntervalMs: 1_000, decisionIntervalMs: 1_000, tickLengthMs: 250 },
    });

    expect(report.series.length).toBeGreaterThan(0);
    expect(report.meta.botId).toBe("greedy");
    expect(report.purchaseRotation).toEqual({ switches: expect.any(Number), perHour: expect.any(Number) });
    expect(Array.isArray(report.milestones)).toBe(true);
  });

  it("never writes to the console", () => {
    runBalanceSim({
      state: tinyState(),
      bot: new GreedyBot(),
      params: { durationMs: 5_000, sampleIntervalMs: 1_000, decisionIntervalMs: 1_000, tickLengthMs: 250 },
    });

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// clickable
// ---------------------------------------------------------------------------

/** Constant-cost linear scaling (coeff 0): `nextUnitCost` is `base` forever, regardless of `bought`. */
const constCostScaling = (base: number) => ({ base: NR(base), coeff: NR(0), func: ScalingMethod.Linear, scaleOn: ScaleOn.self });

/** A primary currency + one producer priced (in `producerCurrencyCode`) at a constant cost, producing primary. */
function stuckState(opts: { primaryAmount: number; cost?: number; producerCurrencyCode?: string; extraCurrencies?: Currency[] }): GameState {
  const primary: Currency = { code: "primary", name: "Primary", primary: true, amount: NR(opts.primaryAmount), persecDelta: NR(0) };
  const producer: Producer = {
    code: "p1",
    name: "Producer",
    currencyCode: opts.producerCurrencyCode ?? "primary",
    amount: NR(0),
    bought: NR(0),
    produces: [{ code: "primary", persec: NR(1) }],
    scaling: constCostScaling(opts.cost ?? 100),
  };

  return { ...createInitialState(), producers: [producer], currencies: [primary, ...(opts.extraCurrencies ?? [])], prestiges: [], upgrades: [] };
}

describe("runBalanceSim with clickable", () => {
  it("without clickable the producer is never bought; with it, it is bought around 85-90s and clicks.count is 85-90", () => {
    const clickable: ResolvedClickable = { currencyCode: "primary", gain: 1, cooldownMs: 1000 };
    const params = { durationMs: 120_000, sampleIntervalMs: 1_000, decisionIntervalMs: 1_000, tickLengthMs: 250 };

    const without = runBalanceSim({ state: stuckState({ primaryAmount: 15 }), bot: new GreedyBot(), params });
    expect(without.actionsCount.p1).toBeUndefined();
    expect(without.clicks).toEqual({ count: 0, lastMs: null });

    const withClick = runBalanceSim({ state: stuckState({ primaryAmount: 15 }), bot: new GreedyBot(), params, clickable });
    expect(withClick.actionsCount.p1).toBe(1);
    expect(withClick.clicks.count).toBeGreaterThanOrEqual(85);
    expect(withClick.clicks.count).toBeLessThanOrEqual(90);

    const buy = withClick.actions.find((a) => a.kind === "buyProducer");
    expect(buy?.tSimMs).toBeGreaterThanOrEqual(84_000);
    expect(buy?.tSimMs).toBeLessThanOrEqual(91_000);
  });

  it("never taps when the primary is already rich (nothing is stuck)", () => {
    const clickable: ResolvedClickable = { currencyCode: "primary", gain: 1, cooldownMs: 1000 };
    const report = runBalanceSim({
      state: stuckState({ primaryAmount: 10_000 }),
      bot: new GreedyBot(),
      params: { durationMs: 5_000, sampleIntervalMs: 1_000, decisionIntervalMs: 1_000, tickLengthMs: 250 },
      clickable,
    });

    expect(report.clicks).toEqual({ count: 0, lastMs: null });
  });

  it("taps 3 times in the first 1000ms chunk, then 2 per chunk, at cooldownMs 500 with 1000ms chunks", () => {
    const clickable: ResolvedClickable = { currencyCode: "primary", gain: 1, cooldownMs: 500 };
    const report = runBalanceSim({
      state: stuckState({ primaryAmount: 0, cost: 100_000 }),
      bot: new GreedyBot(),
      // decisionIntervalMs way past durationMs: the producer is never remotely affordable, so the bot never fires.
      params: { durationMs: 5_000, sampleIntervalMs: 1_000, decisionIntervalMs: 1_000_000, tickLengthMs: 250 },
      clickable,
    });

    // 3 taps in chunk 1 (catch-up from nextTapMs = 0), then a steady 2/chunk in chunks 2-5.
    expect(report.clicks.count).toBe(3 + 2 * 4);
  });

  it("caps taps at the deficit: gain 10 against a 25 deficit taps exactly 3 times, then the producer is bought", () => {
    const clickable: ResolvedClickable = { currencyCode: "primary", gain: 10, cooldownMs: 1000 };
    const report = runBalanceSim({
      state: stuckState({ primaryAmount: 75, cost: 100 }),
      bot: new GreedyBot(),
      params: { durationMs: 5_000, sampleIntervalMs: 1_000, decisionIntervalMs: 1_000, tickLengthMs: 250 },
      clickable,
    });

    expect(report.clicks.count).toBe(3);
    expect(report.actionsCount.p1).toBe(1);
  });

  it("never taps when the only blocking producer is priced in another currency", () => {
    const motes: Currency = { code: "motes", name: "Motes", amount: NR(0) };
    const clickable: ResolvedClickable = { currencyCode: "primary", gain: 1, cooldownMs: 1000 };

    const report = runBalanceSim({
      state: stuckState({ primaryAmount: 15, producerCurrencyCode: "motes", extraCurrencies: [motes] }),
      bot: new GreedyBot(),
      params: { durationMs: 5_000, sampleIntervalMs: 1_000, decisionIntervalMs: 1_000, tickLengthMs: 250 },
      clickable,
    });

    expect(report.clicks).toEqual({ count: 0, lastMs: null });
  });

  it("never throws and never taps when the clickable's currency does not exist", () => {
    const clickable: ResolvedClickable = { currencyCode: "phantom", gain: 1, cooldownMs: 1000 };

    const report = runBalanceSim({
      state: stuckState({ primaryAmount: 15 }),
      bot: new GreedyBot(),
      params: { durationMs: 5_000, sampleIntervalMs: 1_000, decisionIntervalMs: 1_000, tickLengthMs: 250 },
      clickable,
    });

    expect(report.clicks).toEqual({ count: 0, lastMs: null });
  });
});
