import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Currency, Prestige, Producer } from "../models/base";
import { ScaleOn, ScalingMethod } from "../models/base";
import { NR } from "../nums";
import { createInitialState } from "../state";
import type { GameState } from "../state";
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
