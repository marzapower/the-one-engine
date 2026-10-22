import { describe, expect, it } from "vitest";

import type { Currency, GrowthFunction, Producer, Upgrade } from "../models/base";
import { ScaleOn, ScalingMethod } from "../models/base";
import { N, NR } from "../nums";
import { type GameState, createInitialState } from "../state";
import { Engine } from "./engine";
import { buyProducer, buyUpgrade, findCostPool, isUnlocked, producerPurchaseBlock, upgradePurchaseBlock } from "./purchase";

const lin = (base: number, coeff = 0): GrowthFunction => ({ base: NR(base), coeff: NR(coeff), func: ScalingMethod.Linear, scaleOn: ScaleOn.self });

const currency = (code: string, amount: number, extra: Partial<Currency> = {}): Currency => ({ code, name: code, amount: NR(amount), ...extra });
const producer = (code: string, extra: Partial<Producer> = {}): Producer => ({
  code,
  name: code,
  amount: NR(0),
  bought: NR(0),
  currencyCode: "one",
  scaling: lin(10),
  produces: [],
  ...extra,
});
const upgrade = (code: string, extra: Partial<Upgrade> = {}): Upgrade => ({
  code,
  name: code,
  amount: NR(0),
  bought: NR(0),
  currencyCode: "one",
  scaling: lin(10),
  effects: [],
  ...extra,
});

function stateOf(parts: Partial<GameState>): GameState {
  return { ...createInitialState(), ...parts };
}

describe("isUnlocked", () => {
  it("is true without an unlock", () => {
    expect(isUnlocked(stateOf({}), {})).toBe(true);
  });

  it("compares the field strictly against gt, per kind", () => {
    const state = stateOf({
      currencies: [currency("dd", 0, { earned: NR(5) })],
      producers: [producer("e1", { amount: NR(3), bought: NR(2) })],
      upgrades: [upgrade("u", { bought: NR(1) })],
    });
    expect(isUnlocked(state, { unlock: { kind: "currency", code: "dd", field: "earned", gt: NR(0) } })).toBe(true);
    expect(isUnlocked(state, { unlock: { kind: "currency", code: "dd", field: "earned", gt: NR(5) } })).toBe(false);
    expect(isUnlocked(state, { unlock: { kind: "producer", code: "e1", field: "bought", gt: NR(1) } })).toBe(true);
    expect(isUnlocked(state, { unlock: { kind: "producer", code: "e1", field: "amount", gt: NR(3) } })).toBe(false);
    expect(isUnlocked(state, { unlock: { kind: "upgrade", code: "u", field: "bought", gt: NR(0) } })).toBe(true);
  });

  it("is false when the referenced entity is missing", () => {
    expect(isUnlocked(stateOf({}), { unlock: { kind: "currency", code: "nope", field: "amount", gt: NR(0) } })).toBe(false);
  });
});

describe("buyUpgrade / upgradePurchaseBlock", () => {
  it("buys one level and spends the cost", () => {
    const engine = new Engine();
    const state = stateOf({ currencies: [currency("one", 25)], upgrades: [upgrade("u")] });
    expect(buyUpgrade(engine, state, "u")).toBe(true);
    expect(N(state.upgrades[0]!.bought).toNumber()).toBe(1);
    expect(N(state.upgrades[0]!.amount).toNumber()).toBe(1);
    expect(N(state.currencies[0]!.amount).toNumber()).toBe(15);
  });

  it("reports blocks in order: unknown, maxed, locked, noPool, unaffordable", () => {
    const engine = new Engine();
    const locked = upgrade("locked", { unlock: { kind: "currency", code: "one", field: "earned", gt: NR(100) } });
    const state = stateOf({
      currencies: [currency("one", 5)],
      upgrades: [upgrade("maxed", { max: NR(1), amount: NR(1), bought: NR(1) }), locked, upgrade("nopool", { currencyCode: "ghost" }), upgrade("poor")],
    });
    expect(upgradePurchaseBlock(engine, state, upgrade("zzz"))).toBe("unknown");
    expect(upgradePurchaseBlock(engine, state, state.upgrades[0]!)).toBe("maxed");
    expect(upgradePurchaseBlock(engine, state, locked)).toBe("locked");
    expect(upgradePurchaseBlock(engine, state, state.upgrades[2]!)).toBe("noPool");
    expect(upgradePurchaseBlock(engine, state, state.upgrades[3]!)).toBe("unaffordable");
    expect(buyUpgrade(engine, state, "poor")).toBe(false);
    expect(buyUpgrade(engine, state, "missing")).toBe(false);
  });

  it("checks max against amount + 1", () => {
    const engine = new Engine();
    const state = stateOf({ currencies: [currency("one", 1000)], upgrades: [upgrade("u", { max: NR(2) })] });
    expect(buyUpgrade(engine, state, "u")).toBe(true);
    expect(buyUpgrade(engine, state, "u")).toBe(true);
    expect(buyUpgrade(engine, state, "u")).toBe(false);
  });

  it("pays from a producer's stock when the cost pool is a producer", () => {
    const engine = new Engine();
    const state = stateOf({ producers: [producer("p", { amount: NR(50) })], upgrades: [upgrade("u", { currencyCode: "p" })] });
    expect(findCostPool(state, "p")).toBe(state.producers[0]);
    expect(buyUpgrade(engine, state, "u")).toBe(true);
    expect(N(state.producers[0]!.amount).toNumber()).toBe(40);
  });

  it("a locked upgrade becomes buyable once the unlock opens", () => {
    const engine = new Engine();
    const state = stateOf({
      currencies: [currency("one", 100), currency("dd", 0, { earned: NR(0) })],
      upgrades: [upgrade("wall", { unlock: { kind: "currency", code: "dd", field: "earned", gt: NR(0) } })],
    });
    expect(buyUpgrade(engine, state, "wall")).toBe(false);
    state.currencies[1]!.earned = NR(1);
    expect(buyUpgrade(engine, state, "wall")).toBe(true);
  });
});

describe("grantOnPurchase", () => {
  const grantEffect = (target: string, perLevel: number) => ({
    stage: 0 as const,
    target: { kind: "producer" as const, code: target, path: "resetsTo" },
    type: "add",
    func: lin(0, perLevel),
  });

  it("adds v(new) - v(old) to the producer amount, at level 0 and level 1, never to bought", () => {
    const engine = new Engine();
    const state = stateOf({
      currencies: [currency("one", 1000)],
      producers: [producer("e1", { resetsTo: NR(0) })],
      upgrades: [upgrade("sev", { grantOnPurchase: true, effects: [grantEffect("e1", 10)], scaling: lin(1) })],
    });
    expect(buyUpgrade(engine, state, "sev")).toBe(true);
    expect(N(state.producers[0]!.amount).toNumber()).toBe(10);
    expect(buyUpgrade(engine, state, "sev")).toBe(true);
    expect(N(state.producers[0]!.amount).toNumber()).toBe(20);
    expect(N(state.producers[0]!.bought).toNumber()).toBe(0);
  });

  it("the granted stock can make another upgrade payable (producer pool)", () => {
    const engine = new Engine();
    const state = stateOf({
      currencies: [currency("one", 5)],
      producers: [producer("e1", { resetsTo: NR(0) })],
      upgrades: [upgrade("sev", { grantOnPurchase: true, effects: [grantEffect("e1", 10)], scaling: lin(1) }), upgrade("u1", { currencyCode: "e1", scaling: lin(10) })],
    });
    expect(buyUpgrade(engine, state, "u1")).toBe(false);
    buyUpgrade(engine, state, "sev");
    expect(buyUpgrade(engine, state, "u1")).toBe(true);
  });

  it("does nothing without the flag", () => {
    const engine = new Engine();
    const state = stateOf({ currencies: [currency("one", 100)], producers: [producer("e1")], upgrades: [upgrade("sev", { effects: [grantEffect("e1", 10)], scaling: lin(1) })] });
    buyUpgrade(engine, state, "sev");
    expect(N(state.producers[0]!.amount).toNumber()).toBe(0);
  });
});

describe("buyProducer / producerPurchaseBlock", () => {
  it("buys several units at the summed price", () => {
    const engine = new Engine();
    const state = stateOf({ currencies: [currency("one", 100)], producers: [producer("p")] });
    expect(buyProducer(engine, state, "p", 3)).toBe(true);
    expect(N(state.producers[0]!.bought).toNumber()).toBe(3);
    expect(N(state.producers[0]!.amount).toNumber()).toBe(3);
    expect(N(state.currencies[0]!.amount).toNumber()).toBe(70);
  });

  it("blocks: unknown, maxed, locked, noPool, unaffordable", () => {
    const engine = new Engine();
    const state = stateOf({
      currencies: [currency("one", 5)],
      producers: [
        producer("maxed", { max: NR(1), amount: NR(1), bought: NR(1) }),
        producer("fed", { max: NR(1), amount: NR(50) }),
        producer("locked", { unlock: { kind: "producer", code: "maxed", field: "amount", gt: NR(5) } }),
        producer("nopool", { currencyCode: "ghost" }),
        producer("poor"),
      ],
    });
    expect(producerPurchaseBlock(engine, state, state.producers[4]!, 0)).toBe("unknown");
    expect(producerPurchaseBlock(engine, state, state.producers[0]!, 1)).toBe("maxed");
    // `max` caps purchases (`bought`), not the stock a higher tier produced.
    expect(producerPurchaseBlock(engine, state, state.producers[1]!, 1)).toBe("unaffordable");
    expect(producerPurchaseBlock(engine, state, state.producers[2]!, 1)).toBe("locked");
    expect(producerPurchaseBlock(engine, state, state.producers[3]!, 1)).toBe("noPool");
    expect(producerPurchaseBlock(engine, state, state.producers[4]!, 1)).toBe("unaffordable");
    expect(producerPurchaseBlock(engine, state, { ...state.producers[4]!, code: "zzz" }, 1)).toBe("unknown");
    expect(buyProducer(engine, state, "poor", 1)).toBe(false);
  });

  it("can be paid with another producer's stock", () => {
    const engine = new Engine();
    const state = stateOf({ producers: [producer("fly", { currencyCode: "cocoon" }), producer("cocoon", { amount: NR(20) })] });
    expect(buyProducer(engine, state, "fly", 1)).toBe(true);
    expect(N(state.producers[1]!.amount).toNumber()).toBe(10);
  });

  it("is reachable through the Engine delegates", () => {
    const engine = new Engine();
    const state = stateOf({ currencies: [currency("one", 100)], producers: [producer("p")], upgrades: [upgrade("u")] });
    expect(engine.buyProducer(state, "p", 1)).toBe(true);
    expect(engine.buyUpgrade(state, "u")).toBe(true);
    expect(engine.isUnlocked(state, state.upgrades[0]!)).toBe(true);
  });
});
