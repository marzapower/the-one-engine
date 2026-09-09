import { beforeEach, describe, expect, it } from "vitest";

import { Engine } from "../core/engine";
import type { Currency, Producer } from "../models/base";
import { ScaleOn } from "../models/base";
import { N, NR } from "../nums";
import { applyCubicAddon, isCubicAddonApplied, removeCubicAddon } from "./cubic-addon";

describe("cubic addon", () => {
  let engine: Engine;

  beforeEach(() => {
    engine = new Engine();
  });

  it("applyCubicAddon registers all components", () => {
    applyCubicAddon(engine);

    expect(engine.growths.lookup("cubic")).toBeDefined();
    expect(engine.effectTypes.lookup("pow")).toBeDefined();
    expect(engine.stages.lookup("LogTick")).toBeDefined();
  });

  it("applyCubicAddon throws on duplicate without override", () => {
    applyCubicAddon(engine);
    expect(() => applyCubicAddon(engine, false)).toThrow("Cubic addon already applied");
  });

  it("applyCubicAddon(engine, true) allows re-registration without throwing", () => {
    applyCubicAddon(engine);
    applyCubicAddon(engine, true);

    expect(engine.growths.lookup("cubic")).toBeDefined();
    expect(engine.effectTypes.lookup("pow")).toBeDefined();
    expect(engine.stages.lookup("LogTick")).toBeDefined();
  });

  it("removeCubicAddon unregisters all components", () => {
    applyCubicAddon(engine);
    removeCubicAddon(engine);

    expect(engine.growths.lookup("cubic")).toBeUndefined();
    expect(engine.effectTypes.lookup("pow")).toBeUndefined();
    expect(engine.stages.lookup("LogTick")).toBeUndefined();
  });

  it("removeCubicAddon is safe to call when not applied", () => {
    expect(() => removeCubicAddon(engine)).not.toThrow();
  });

  it("isCubicAddonApplied reports the current state", () => {
    expect(isCubicAddonApplied(engine)).toBe(false);
    applyCubicAddon(engine);
    expect(isCubicAddonApplied(engine)).toBe(true);
    removeCubicAddon(engine);
    expect(isCubicAddonApplied(engine)).toBe(false);
  });

  it("does not affect components on a second, independent engine", () => {
    const other = new Engine();
    applyCubicAddon(engine);

    expect(isCubicAddonApplied(engine)).toBe(true);
    expect(isCubicAddonApplied(other)).toBe(false);
  });

  it("cubic growth compute formula is correct", () => {
    applyCubicAddon(engine);
    const growth = engine.growths.lookup("cubic");
    expect(growth).toBeDefined();
    if (!growth) return;

    // F(3) = 2 * (3+1)^3 + 1 = 2 * 64 + 1 = 129
    const result = growth.compute(NR(2), NR(0), NR(1), NR(3));
    expect(result.sub(129).abs().lte(1e-9)).toBe(true);
  });

  it("cubic growth sumToN formula is correct", () => {
    applyCubicAddon(engine);
    const growth = engine.growths.lookup("cubic");
    expect(growth?.sumToN).toBeDefined();
    if (!growth?.sumToN) return;

    // S(3) with base=1, offset=0, C=0: sum of (k+1)^3 for k=0..2 = 1 + 8 + 27 = 36
    const result = growth.sumToN(NR(1), NR(0), NR(0), NR(0), NR(3));
    expect(result.toNumber()).toBe(36);
  });

  it("cubic growth capabilities are correct", () => {
    applyCubicAddon(engine);
    const growth = engine.growths.lookup("cubic");
    expect(growth?.capabilities.hasClosedFormSum).toBe(true);
    expect(growth?.capabilities.hasClosedFormNmax).toBe(false);
  });

  it("pow effect type apply formula is correct", () => {
    applyCubicAddon(engine);
    const effect = engine.effectTypes.lookup("pow");
    expect(effect).toBeDefined();
    if (!effect) return;

    // apply(2, 3) = 2^3 = 8
    const result = effect.apply(N(2), N(3));
    expect(N(result).sub(8).abs().lte(1e-9)).toBe(true);
  });

  it("pow effect type has the declared priority and stages", () => {
    applyCubicAddon(engine);
    const effect = engine.effectTypes.lookup("pow");
    expect(effect?.priority).toBe(300);
    expect(effect?.allowedStages).toEqual([0, 1, 2]);
  });

  it("LogTick stage sits after Upgrades(2) in the tick order", () => {
    applyCubicAddon(engine);
    const stages = engine.stages.list();

    const logTick = stages.find((s) => s.id === "LogTick");
    const upgrades2 = stages.find((s) => s.id === "Upgrades(2)");

    expect(logTick).toBeDefined();
    expect(upgrades2).toBeDefined();
    expect(logTick!.priority).toBeGreaterThan(upgrades2!.priority);
  });

  it("built-in growth, effect and stage ids survive the addon", () => {
    applyCubicAddon(engine);

    expect(engine.growths.lookup("linear")).toBeDefined();
    expect(engine.growths.lookup("geometric")).toBeDefined();
    expect(engine.effectTypes.lookup("add")).toBeDefined();
    expect(engine.effectTypes.lookup("mult")).toBeDefined();
    expect(engine.stages.lookup("Produce")).toBeDefined();
  });

  it("costToBuyNext uses the cubic growth via the engine's registry", () => {
    applyCubicAddon(engine);

    const producer: Producer = {
      code: "test_cubic",
      name: "Test Cubic",
      produces: [],
      amount: NR(0),
      bought: NR(0),
      currencyCode: "gold",
      scaling: {
        base: NR(1),
        coeff: NR(0),
        offset: NR(0),
        func: "cubic",
        scaleOn: ScaleOn.self,
      },
    };

    // Cost to buy 3 items: sum of (k+1)^3 for k=0..2 = 1 + 8 + 27 = 36
    const cost = engine.costToBuyNext(producer, NR(3));
    expect(N(cost).toNumber()).toBe(36);
  });

  it("maxBuyableAmount falls back to a binary search for cubic (no closed-form Nmax)", () => {
    applyCubicAddon(engine);

    const producer: Producer = {
      code: "test_cubic_max",
      name: "Test Cubic Max",
      produces: [],
      amount: NR(0),
      bought: NR(0),
      currencyCode: "gold",
      scaling: {
        base: NR(1),
        coeff: NR(0),
        offset: NR(0),
        func: "cubic",
        scaleOn: ScaleOn.self,
      },
    };

    const currency: Currency = {
      code: "gold",
      name: "Gold",
      amount: NR(36),
    };

    const maxBuyable = engine.maxBuyableAmount(producer, currency);
    expect(N(maxBuyable).toNumber()).toBe(3);

    const cost3 = engine.costToBuyNext(producer, NR(3));
    const cost4 = engine.costToBuyNext(producer, NR(4));
    expect(N(cost3).lte(N(36))).toBe(true);
    expect(N(cost4).gt(N(36))).toBe(true);
  });
});
