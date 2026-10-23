import { describe, expect, it } from "vitest";

import type { Currency, GrowthFunction, Producer, Upgrade } from "../models/base";
import { ScaleOn, ScalingMethod } from "../models/base";
import { N, NR } from "../nums";
import { type GameState, createInitialState } from "../state";
import { Engine } from "./engine";
import { buyProducer, buyUpgrade, costShortfalls, findCostPool, isUnlocked, producerPurchaseBlock, upgradePurchaseBlock } from "./purchase";

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

describe("extra costs", () => {
  const geo = (base: number, coeff: number): GrowthFunction => ({ base: NR(base), coeff: NR(coeff), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self });
  const amountOf = (state: GameState, code: string): number => N(findCostPool(state, code)!.amount).toNumber();

  // Time Fly: main tick 1e5·4^b, extra tack and tock equal.
  const fly = (): Producer =>
    producer("fly", {
      currencyCode: "tick",
      scaling: geo(1e5, 4),
      extraCosts: [
        { currencyCode: "tack", scaling: geo(1e5, 4) },
        { currencyCode: "tock", scaling: geo(1e5, 4) },
      ],
    });
  // Creature: main cocoon 1·3^b, extras 900·4^b from the second unit.
  const creature = (): Producer =>
    producer("t1", {
      currencyCode: "cocoon",
      scaling: geo(1, 3),
      extraCosts: [
        { currencyCode: "tack", scaling: geo(900, 4), fromBought: 1 },
        { currencyCode: "tock", scaling: geo(900, 4), fromBought: 1 },
      ],
    });
  const flyState = (tick: number, tack: number, tock: number): GameState =>
    stateOf({ currencies: [currency("tick", tick), currency("tack", tack), currency("tock", tock)], producers: [fly()] });

  it("a three-cost producer debits every pool at once", () => {
    const engine = new Engine();
    const state = flyState(5e5, 4e5, 3e5);
    expect(buyProducer(engine, state, "fly", 1)).toBe(true);
    expect([amountOf(state, "tick"), amountOf(state, "tack"), amountOf(state, "tock")]).toEqual([4e5, 3e5, 2e5]);
    expect(N(state.producers[0]!.bought).toNumber()).toBe(1);
  });

  it("denies the purchase and touches no pool when a single pool is short", () => {
    const engine = new Engine();
    const state = flyState(1e9, 1e9, 99_999);
    expect(producerPurchaseBlock(engine, state, state.producers[0]!, 1)).toBe("unaffordable");
    expect(buyProducer(engine, state, "fly", 1)).toBe(false);
    expect([amountOf(state, "tick"), amountOf(state, "tack"), amountOf(state, "tock")]).toEqual([1e9, 1e9, 99_999]);
    expect(N(state.producers[0]!.bought).toNumber()).toBe(0);
  });

  it("the first creature costs only its main pool, the second pays the extras too", () => {
    const engine = new Engine();
    const state = stateOf({ producers: [creature(), producer("sink")], currencies: [currency("tack", 0), currency("tock", 0)] });
    state.producers.push(producer("cocoon", { amount: NR(100) }));
    state.producers[0]!.currencyCode = "cocoon";
    expect(buyProducer(engine, state, "t1", 1)).toBe(true);
    expect([amountOf(state, "cocoon"), amountOf(state, "tack"), amountOf(state, "tock")]).toEqual([99, 0, 0]);

    expect(producerPurchaseBlock(engine, state, state.producers[0]!, 1)).toBe("unaffordable");
    state.currencies[0]!.amount = NR(3600);
    state.currencies[1]!.amount = NR(3700);
    expect(buyProducer(engine, state, "t1", 1)).toBe(true);
    expect([amountOf(state, "cocoon"), amountOf(state, "tack"), amountOf(state, "tock")]).toEqual([96, 0, 100]);
  });

  it("reports noPool for an undefined extra pool, even when that extra is still free", () => {
    const engine = new Engine();
    const state = stateOf({ currencies: [currency("tack", 0)], producers: [creature(), producer("cocoon", { amount: NR(100) })] });
    state.producers[0]!.currencyCode = "cocoon";
    // tock is missing; bought = 0 makes both extras free
    expect(producerPurchaseBlock(engine, state, state.producers[0]!, 1)).toBe("noPool");
    expect(buyProducer(engine, state, "t1", 1)).toBe(false);
    expect(N(state.producers[1]!.amount).toNumber()).toBe(100);
  });

  it("an upgrade with two costs is atomic and pays both", () => {
    const engine = new Engine();
    const u = upgrade("u-split", { currencyCode: "a", scaling: geo(900, 4), extraCosts: [{ currencyCode: "b", scaling: geo(300, 4) }] });
    const state = stateOf({ currencies: [currency("a", 900), currency("b", 299)], upgrades: [u] });
    expect(upgradePurchaseBlock(engine, state, u)).toBe("unaffordable");
    expect(buyUpgrade(engine, state, "u-split")).toBe(false);
    expect([amountOf(state, "a"), amountOf(state, "b")]).toEqual([900, 299]);

    state.currencies[1]!.amount = NR(1000);
    expect(buyUpgrade(engine, state, "u-split")).toBe(true);
    expect([amountOf(state, "a"), amountOf(state, "b")]).toEqual([0, 700]);
    // second level: 900·4 and 300·4
    state.currencies[0]!.amount = NR(3599);
    expect(upgradePurchaseBlock(engine, state, u)).toBe("unaffordable");
    state.currencies[0]!.amount = NR(3600);
    state.currencies[1]!.amount = NR(1200);
    expect(buyUpgrade(engine, state, "u-split")).toBe(true);
    expect([amountOf(state, "a"), amountOf(state, "b")]).toEqual([0, 0]);
  });

  it("extras can be paid in a producer's stock", () => {
    const engine = new Engine();
    const u = upgrade("u", { currencyCode: "one", scaling: lin(10), extraCosts: [{ currencyCode: "drone", scaling: lin(5) }] });
    const state = stateOf({ currencies: [currency("one", 10)], producers: [producer("drone", { amount: NR(4) })], upgrades: [u] });
    expect(upgradePurchaseBlock(engine, state, u)).toBe("unaffordable");
    state.producers[0]!.amount = NR(7);
    expect(buyUpgrade(engine, state, "u")).toBe(true);
    expect(N(state.producers[0]!.amount).toNumber()).toBe(2);
  });

  it("costShortfalls lists missing and short pools in line order, skipping free lines with a pool", () => {
    const engine = new Engine();
    const state = stateOf({ currencies: [currency("tick", 1e9), currency("tack", 10)], producers: [fly()] });
    // tack short, tock missing
    expect(costShortfalls(engine, state, state.producers[0]!, 1)).toEqual(["tack", "tock"]);
    expect(engine.costShortfalls(state, state.producers[0]!)).toEqual(["tack", "tock"]);
    expect(producerPurchaseBlock(engine, state, state.producers[0]!, 1)).toBe("noPool");

    const full = flyState(1e9, 1e9, 1e9);
    expect(costShortfalls(engine, full, full.producers[0]!, 1)).toEqual([]);

    const free = stateOf({ currencies: [currency("tack", 0), currency("tock", 0)], producers: [creature(), producer("cocoon", { amount: NR(1) })] });
    free.producers[0]!.currencyCode = "cocoon";
    expect(costShortfalls(engine, free, free.producers[0]!, 1)).toEqual([]);
  });

  it("rejects fractional, NaN, infinite and non-positive amounts as unknown", () => {
    const engine = new Engine();
    const state = flyState(1e12, 1e12, 1e12);
    const p = state.producers[0]!;
    for (const amount of [1.5, NaN, Infinity, 0, -1]) {
      expect(producerPurchaseBlock(engine, state, p, amount)).toBe("unknown");
      expect(buyProducer(engine, state, "fly", amount)).toBe(false);
    }
    expect(N(p.bought).toNumber()).toBe(0);
  });

  it("maxBuyableAcrossPools through the engine ignores max, while the block reports maxed", () => {
    const engine = new Engine();
    const loose = producer("loose", {
      currencyCode: "tack",
      scaling: lin(3600, 0),
      extraCosts: [{ currencyCode: "tock", scaling: lin(3600, 0) }],
      max: NR(1),
      bought: NR(1),
      amount: NR(1),
    });
    const state = stateOf({ currencies: [currency("tack", 7200), currency("tock", 7200)], producers: [loose] });
    expect(N(engine.maxBuyableAcrossPools(state, loose)).toNumber()).toBe(2);
    expect(producerPurchaseBlock(engine, state, loose, 1)).toBe("maxed");
    expect(engine.costLinesToBuyNext(loose, 1).map((l) => l.currencyCode)).toEqual(["tack", "tock"]);
  });

  it("maxBuyableAcrossPools resolves pools in the state and gives 0 for a missing one", () => {
    const engine = new Engine();
    const state = flyState(1e6, 1e9, 1e9);
    expect(N(engine.maxBuyableAcrossPools(state, state.producers[0]!)).toNumber()).toBe(2);
    state.currencies.pop();
    expect(N(engine.maxBuyableAcrossPools(state, state.producers[0]!)).toNumber()).toBe(0);
  });
});
