import { describe, expect, it } from "vitest";

import { silentLogger } from "../core/di/defaults";
import { Engine } from "../core/engine";
import type { Currency, Producer } from "../models/base";
import { ScaleOn, ScalingMethod } from "../models/base";
import { NR } from "../nums";
import { createInitialState } from "../state";
import type { GameState } from "../state";
import { MockTimeProvider } from "../testing/MockTimeProvider";
import { MetricsCollector } from "./metrics";
import { saturationOnsetDetector } from "./saturation-onset";

function newEngine(): Engine {
  return new Engine(250, { time: new MockTimeProvider(250), logger: silentLogger });
}

function stateWithProducer(overrides: Partial<GameState> = {}, producerOverrides: Partial<Producer> = {}): GameState {
  const primary: Currency = { code: "primary", name: "Primary", primary: true, amount: NR(0) };
  const producer: Producer = {
    code: "p1",
    name: "Producer",
    currencyCode: "primary",
    amount: NR(100),
    bought: NR(0),
    produces: [{ code: "primary", persec: NR(1) }],
    scaling: { base: NR(1), coeff: NR(1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
    capacity: { base: NR(10), factor: NR(2), decayScale: 2 },
    ...producerOverrides,
  };

  return {
    ...createInitialState(),
    currencies: [primary],
    producers: [producer],
    ...overrides,
  };
}

describe("saturationOnsetDetector", () => {
  it("never fires on a state without rules", () => {
    const engine = newEngine();
    const detector = saturationOnsetDetector(engine);
    const state = stateWithProducer();

    expect(detector(state, 0)).toBeUndefined();
  });

  it("does not fire when saturation is gated and the gate currency hasn't reached the threshold", () => {
    const engine = newEngine();
    const detector = saturationOnsetDetector(engine);
    const state = stateWithProducer({
      rules: { saturation: { gate: { currencyCode: "gate", earnedAtLeast: 30 } } },
    });

    expect(detector(state, 0)).toBeUndefined();
  });

  it("does not fire when saturation is active but no producer exceeds its capacity", () => {
    const engine = newEngine();
    const detector = saturationOnsetDetector(engine);
    const state = stateWithProducer({ rules: { saturation: {} } }, { amount: NR(5) }); // below capacity.base = 10

    expect(detector(state, 0)).toBeUndefined();
  });

  it("fires once when saturation is active and a producer exceeds its capacity", () => {
    const engine = newEngine();
    const state = stateWithProducer({ rules: { saturation: {} } }, { amount: NR(1000) }); // well above capacity.base = 10

    const collector = new MetricsCollector(engine, {}, [saturationOnsetDetector(engine)]);
    collector.onSample(state, 0);
    collector.onSample(state, 1000);
    collector.onSample(state, 2000);

    const report = collector.finalize(state, 3000);
    const fired = report.milestones.filter((m) => m.event === "saturation:onset");

    expect(fired).toHaveLength(1);
    expect(fired[0]?.detail).toEqual({ code: "p1" });
  });
});
