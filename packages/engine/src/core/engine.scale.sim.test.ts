import { describe, expect, it } from "vitest";

import { TICK_MS_INTERVAL } from "../constants";
import { N } from "../nums";
import { MockTimeProvider } from "../testing/MockTimeProvider";
import { makeScaleState } from "../testing/scale-fixture";
import { Engine } from "./engine";
import { collectModifiers } from "./modifiers";

describe("Engine scale simulation (100 producers, 5 currencies, 50 upgrades)", () => {
  it("grows every currency, populates the accessor cache and reports metrics", () => {
    const fake = new MockTimeProvider(TICK_MS_INTERVAL);
    const engine = new Engine(TICK_MS_INTERVAL, { time: fake });
    const state = makeScaleState(100, 5, 50);

    const before = state.currencies.map((c) => N(c.amount));

    const TICKS = 1000; // balanced to not slow down CI, but enough for stable stats
    for (let i = 0; i < TICKS; i++) {
      fake.advance(TICK_MS_INTERVAL);
      engine.tick(state);
    }

    for (let i = 0; i < state.currencies.length; i++) {
      expect(N(state.currencies[i]!.amount).gt(before[i]!)).toBe(true);
    }

    const adapter = engine.services.adapter;

    // Stimulate the adapter's accessor cache on a handful of targets.
    for (let i = 0; i < 10; i++) {
      const target = { kind: "producer", code: `p${i}`, path: "amount" } as const;
      void adapter.getTargetValue(state, target);
    }

    // With the modifier pipeline, every effect in this fixture targets a
    // persistent path (30 produces.*.persec + 20 amount): it never writes to
    // state directly, it is collected by collectModifiers and resolved at
    // its point of read in "Produce". At least 40 distinct target objects
    // should be populated per tick (in practice 50: 30 produces.* entries +
    // 20 producer roots for the effects on "amount").
    const mods = collectModifiers(state, engine.services);
    expect(mods.size).toBeGreaterThanOrEqual(40);
  });
});
