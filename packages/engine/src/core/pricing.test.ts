import { describe, expect, it } from "vitest";

import { ScaleOn, ScalingMethod } from "../models/base";
import { Factory } from "../models/base/factory";
import { type Decimal, type GenericNumberInput, N, NR } from "../nums";
import { computeGrowthFunction } from "./growth";
import { costLinesToBuyNext, costToBuy, costToBuyNext, maxBuyableAcrossPools, maxBuyableAmount } from "./pricing";
import { GrowthRegistry } from "./registries/growth";

// Relative tolerance 1e-9: absorbs floating-point noise (same mathematical
// value, last digit differs) without widening past that.
const closeEnough = (a: GenericNumberInput, b: GenericNumberInput): boolean => N(a).sub(N(b)).abs().div(N(b).abs().max(1)).lte(1e-9);

const growths = new GrowthRegistry();

describe("costToBuyNext / maxBuyableAmount / costToBuy", () => {
  describe("for linear scaling", () => {
    it("returns the maximum buyable amount", () => {
      const producer = Factory.buildProducer({
        scaling: { base: NR(10), coeff: NR(5), scaleOn: ScaleOn.self, func: ScalingMethod.Linear },
      });

      // F(0)=10 F(1)=15 F(2)=20 F(3)=25 F(4)=30 -> sum of first 5 = 100
      producer.bought = NR(0);
      expect(maxBuyableAmount(growths, producer, { amount: NR(101) })).toStrictEqual(NR(5));

      producer.bought = NR(7);
      expect(maxBuyableAmount(growths, producer, { amount: NR(101) })).toStrictEqual(NR(2));

      producer.bought = NR(19);
      expect(maxBuyableAmount(growths, producer, { amount: NR(101) })).toStrictEqual(NR(0));

      producer.bought = NR(0);
      expect(maxBuyableAmount(growths, producer, { amount: NR(1e10) })).toStrictEqual(NR(63244));
    });

    it("returns 0 when the pool is empty", () => {
      const producer = Factory.buildProducer({ scaling: { base: NR(10), coeff: NR(5), scaleOn: ScaleOn.self, func: ScalingMethod.Linear } });
      expect(maxBuyableAmount(growths, producer, { amount: NR(0) })).toStrictEqual(NR(0));
    });
  });

  describe("for geometric scaling", () => {
    it("computes cost to buy next matching the closed-form sum", () => {
      const producer = Factory.buildProducer({
        bought: NR(3),
        scaling: { base: NR(10), coeff: NR(1.15), scaleOn: ScaleOn.self, func: ScalingMethod.Geometric },
      });

      // F(3)=10*1.15^3, F(4)=10*1.15^4
      const expected = N(10)
        .mul(N(1.15).pow(3))
        .add(N(10).mul(N(1.15).pow(4)));
      const result = N(costToBuyNext(growths, producer, 2));
      expect(closeEnough(result, expected)).toBe(true);
    });

    it("throws for an unknown growth method", () => {
      const producer = Factory.buildProducer({ scaling: { base: NR(10), coeff: NR(1.15), scaleOn: ScaleOn.self, func: "unknown_method" } });
      expect(() => costToBuyNext(growths, producer, 1)).toThrow('Unknown growth method "unknown_method"');
      expect(() => maxBuyableAmount(growths, producer, { amount: NR(100) })).toThrow('Unknown growth method "unknown_method"');
    });
  });

  describe("costToBuy", () => {
    it("returns cost and amount for an explicit amount", () => {
      const producer = Factory.buildProducer({ scaling: { base: NR(10), coeff: NR(5), scaleOn: ScaleOn.self, func: ScalingMethod.Linear } });
      const { cost, amount } = costToBuy(growths, producer, { amount: NR(1e10) }, 3);
      expect(amount).toStrictEqual(NR(3));
      expect(cost).toStrictEqual(costToBuyNext(growths, producer, 3));
    });

    it("returns 0 cost and amount for a non-positive amount", () => {
      const producer = Factory.buildProducer({ scaling: { base: NR(10), coeff: NR(5), scaleOn: ScaleOn.self, func: ScalingMethod.Linear } });
      expect(costToBuy(growths, producer, { amount: NR(1e10) }, 0)).toStrictEqual({ cost: NR(0), amount: NR(0) });
    });

    it("quotes the maximum buyable amount when amount is omitted", () => {
      const producer = Factory.buildProducer({ scaling: { base: NR(10), coeff: NR(5), scaleOn: ScaleOn.self, func: ScalingMethod.Linear } });
      const { cost, amount } = costToBuy(growths, producer, { amount: NR(101) });
      expect(amount).toStrictEqual(NR(5));
      expect(cost).toStrictEqual(costToBuyNext(growths, producer, 5));
    });

    it("falls back to a quote for 1 unit when nothing is affordable", () => {
      const producer = Factory.buildProducer({ scaling: { base: NR(1000), coeff: NR(5), scaleOn: ScaleOn.self, func: ScalingMethod.Linear } });
      const { cost, amount } = costToBuy(growths, producer, { amount: NR(1) });
      expect(amount).toStrictEqual(NR(1));
      expect(cost).toStrictEqual(costToBuyNext(growths, producer, 1));
    });
  });
});

/**
 * Parity item shared by the golden-value and the self/other agreement
 * tests below: bought 7, scaling base/coeff/offset from GOLDEN.json,
 * otherQuantity 3, pool 1e30.
 */
function buildItem(func: string, base: number, scaleOn: ScaleOn) {
  return Factory.buildProducer({
    bought: NR(7),
    scaling: { base: NR(base), coeff: NR(1.2), offset: NR(3), func, scaleOn },
  });
}

const OTHER_QUANTITY = NR(3);
const POOL = { amount: NR(1e30) };

// GOLDEN.json.pricing["<func>/self"]: item with bought 7, scaling
// { base: 10 (2 for double_exponential), coeff: 1.2, offset: 3, scaleOn self },
// otherQuantity 3, pool 1e30. Values reproduced exactly from the current engine.
describe("GOLDEN pricing parity (scaleOn self)", () => {
  const cases: { func: string; base: number; next1: string; next10: string; max: string }[] = [
    { func: "linear", base: 10, next1: "21.4", next10: "268", max: "1290994448735791" },
    { func: "geometric", base: 10, next1: "38.831807999999995", next10: "960.1465133702184", max: "350" },
    { func: "exponential", base: 10, next1: "251188646.1509582", next10: "1.69162768356678e19", max: "18" },
    { func: "double_exponential", base: 2, next1: "14.9851893773223", next10: "421030.566304604", max: "19" },
  ];

  for (const { func, base, next1, next10, max } of cases) {
    describe(func, () => {
      const item = buildItem(func, base, ScaleOn.self);

      it("next1 matches the golden value", () => {
        expect(costToBuyNext(growths, item, 1, OTHER_QUANTITY)).toStrictEqual(NR(next1));
      });

      it("next10 matches the golden value", () => {
        expect(costToBuyNext(growths, item, 10, OTHER_QUANTITY)).toStrictEqual(NR(next10));
      });

      it("max matches the golden value", () => {
        expect(maxBuyableAmount(growths, item, POOL, OTHER_QUANTITY)).toStrictEqual(NR(max));
      });
    });
  }
});

// scaleOn "other" changes pricing by design (it now agrees with effects,
// see core/growth.ts): assert costToBuyNext(1) against the same resolution
// computeGrowthFunction uses, for both self and other, for every built-in.
describe("pricing agrees with computeGrowthFunction at the current position", () => {
  const funcs = [ScalingMethod.Linear, ScalingMethod.Geometric, ScalingMethod.Exponential, ScalingMethod.DoubleExponential];

  for (const func of funcs) {
    for (const scaleOn of [ScaleOn.self, ScaleOn.other]) {
      it(`${func}/${scaleOn}: costToBuyNext(1) equals computeGrowthFunction at the same quantity`, () => {
        const base = func === ScalingMethod.DoubleExponential ? 2 : 10;
        const item = buildItem(func, base, scaleOn);
        const quantity = scaleOn === ScaleOn.self ? item.bought : OTHER_QUANTITY;

        const nextCost = N(costToBuyNext(growths, item, 1, OTHER_QUANTITY));
        const growthValue = computeGrowthFunction(item.scaling, quantity, growths);

        expect(closeEnough(nextCost, growthValue)).toBe(true);
      });
    }
  }
});

describe("costLinesToBuyNext / maxBuyableAcrossPools", () => {
  const geo = (base: number, coeff: number, scaleOn = ScaleOn.self) => ({ base: NR(base), coeff: NR(coeff), scaleOn, func: ScalingMethod.Geometric });
  const poolsOf = (amounts: Record<string, number>) => (code: string) => (code in amounts ? { amount: NR(amounts[code]!) } : undefined);

  // Time Fly: main tick 1e5·4^b, extra tack/tock equal.
  const fly = (bought = 0) =>
    Factory.buildProducer({
      bought: NR(bought),
      currencyCode: "tick",
      scaling: geo(1e5, 4),
      extraCosts: [
        { currencyCode: "tack", scaling: geo(1e5, 4) },
        { currencyCode: "tock", scaling: geo(1e5, 4) },
      ],
    });
  // Creature: main cocoon 1·3^b, extras 900·4^b from the second unit.
  const creature = (bought = 0) =>
    Factory.buildProducer({
      bought: NR(bought),
      currencyCode: "cocoon",
      scaling: geo(1, 3),
      extraCosts: [
        { currencyCode: "tack", scaling: geo(900, 4), fromBought: 1 },
        { currencyCode: "tock", scaling: geo(900, 4), fromBought: 1 },
      ],
    });

  const asNumbers = (lines: { currencyCode: string; cost: unknown }[]) => lines.map((l) => [l.currencyCode, Math.round(N(l.cost as never).toNumber())]);

  it("without extras gives the single main line, equal to costToBuyNext", () => {
    const item = Factory.buildProducer({ currencyCode: "one", scaling: geo(10, 1.15), bought: NR(3) });
    const lines = costLinesToBuyNext(growths, item, 4);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.currencyCode).toBe("one");
    expect(lines[0]!.cost).toStrictEqual(costToBuyNext(growths, item, 4));
  });

  it("returns [] for amount <= 0", () => {
    expect(costLinesToBuyNext(growths, fly(), 0)).toEqual([]);
    expect(costLinesToBuyNext(growths, fly(), -2)).toEqual([]);
  });

  it("prices a three-cost producer line by line, main first", () => {
    const lines = costLinesToBuyNext(growths, fly(1), 1);
    expect(asNumbers(lines)).toEqual([
      ["tick", 4e5],
      ["tack", 4e5],
      ["tock", 4e5],
    ]);
    const two = costLinesToBuyNext(growths, fly(0), 2);
    expect(asNumbers(two)).toEqual([
      ["tick", 5e5],
      ["tack", 5e5],
      ["tock", 5e5],
    ]);
  });

  it("omits an extra whose fromBought leaves the span free", () => {
    expect(asNumbers(costLinesToBuyNext(growths, creature(0), 1))).toEqual([["cocoon", 1]]);
  });

  it("charges an extra from position fromBought on, without shifting its curve", () => {
    // n.2 (bought = 1): 3 cocoon, 900·4^1 = 3600 per extra pool.
    expect(asNumbers(costLinesToBuyNext(growths, creature(1), 1))).toEqual([
      ["cocoon", 3],
      ["tack", 3600],
      ["tock", 3600],
    ]);
  });

  it("buying 3 at bought 0 with fromBought 1 pays only the last 2 positions on the extras", () => {
    // positions 0,1,2: cocoon 1+3+9 = 13; extras positions 1,2: 3600 + 14400
    expect(asNumbers(costLinesToBuyNext(growths, creature(0), 3))).toEqual([
      ["cocoon", 13],
      ["tack", 18000],
      ["tock", 18000],
    ]);
  });

  it("handles a fractional bought crossing the threshold with Decimal math", () => {
    const item = Factory.buildProducer({
      bought: NR(0.5),
      currencyCode: "m",
      scaling: geo(1, 1.0001),
      extraCosts: [{ currencyCode: "x", scaling: geo(1, 1.0001), fromBought: 1 }],
    });
    // free = ceil(1 - 0.5) = 1: with one unit the extra is omitted, with two it pays one
    expect(costLinesToBuyNext(growths, item, 1)).toHaveLength(1);
    expect(costLinesToBuyNext(growths, item, 2)).toHaveLength(2);
  });

  it("does not convert quantities past MAX_SAFE_INTEGER to number", () => {
    const huge = Factory.buildProducer({
      bought: NR(1e300),
      currencyCode: "m",
      scaling: { base: NR(1), coeff: NR(0), scaleOn: ScaleOn.self, func: ScalingMethod.Linear },
      extraCosts: [{ currencyCode: "x", scaling: { base: NR(1), coeff: NR(0), scaleOn: ScaleOn.self, func: ScalingMethod.Linear }, fromBought: 5 }],
    });
    expect(costLinesToBuyNext(growths, huge, 1)).toHaveLength(2);
    const early = { ...huge, bought: NR(0) };
    // 2^60 units at 0: the first 5 are free on the extra, so it pays 2^60 - 5 units of 1
    const lines = costLinesToBuyNext(growths, early, NR(N(2).pow(60)));
    expect(N(lines[1]!.cost).eq(N(2).pow(60).sub(5))).toBe(true);
  });

  it("forwards otherQuantity unchanged to every line", () => {
    const item = Factory.buildProducer({
      currencyCode: "m",
      scaling: geo(2, 3, ScaleOn.other),
      extraCosts: [{ currencyCode: "x", scaling: geo(2, 3, ScaleOn.other) }],
    });
    const lines = costLinesToBuyNext(growths, item, 1, NR(2));
    expect(N(lines[0]!.cost).eq(N(lines[1]!.cost))).toBe(true);
    expect(N(lines[0]!.cost).eq(N(costToBuyNext(growths, item, 1, NR(2))))).toBe(true);
  });

  it("maxBuyableAcrossPools is the minimum over the pools", () => {
    const item = fly(0); // k units cost 1e5·(4^k − 1)/3 on each pool
    // tick 1e6 -> 3 units (1e5·(64−1)/3 = 2.1e6 > 1e6? 2 units = 5e5, 3 units = 2.1e6) -> 2
    expect(N(maxBuyableAcrossPools(growths, item, poolsOf({ tick: 1e6, tack: 1e9, tock: 1e9 }))).toNumber()).toBe(2);
    // tock is the short one
    expect(N(maxBuyableAcrossPools(growths, item, poolsOf({ tick: 1e9, tack: 1e9, tock: 1e5 }))).toNumber()).toBe(1);
    expect(N(maxBuyableAcrossPools(growths, item, poolsOf({ tick: 1e9, tack: 1e9, tock: 0 }))).toNumber()).toBe(0);
  });

  it("maxBuyableAcrossPools gives 0 when any pool is missing", () => {
    expect(N(maxBuyableAcrossPools(growths, fly(0), poolsOf({ tick: 1e9, tack: 1e9 }))).toNumber()).toBe(0);
    expect(N(maxBuyableAcrossPools(growths, fly(0), poolsOf({ tack: 1e9, tock: 1e9 }))).toNumber()).toBe(0);
  });

  it("maxBuyableAcrossPools counts free extra positions even with an empty extra pool", () => {
    // Only the first unit is free on the extras; cocoon 1 buys exactly it.
    expect(N(maxBuyableAcrossPools(growths, creature(0), poolsOf({ cocoon: 1, tack: 0, tock: 0 }))).toNumber()).toBe(1);
    expect(N(maxBuyableAcrossPools(growths, creature(0), poolsOf({ cocoon: 1e9, tack: 0, tock: 0 }))).toNumber()).toBe(1);
  });

  it("without extras equals maxBuyableAmount on the main pool", () => {
    const item = Factory.buildProducer({ bought: NR(2), currencyCode: "one", scaling: geo(10, 1.15) });
    const pool = { amount: NR(12345) };
    expect(maxBuyableAcrossPools(growths, item, () => pool)).toStrictEqual(maxBuyableAmount(growths, item, pool));
  });

  it("at the computed maximum every line fits; at max + 1 at least one does not", () => {
    const item = creature(1);
    const amounts = { cocoon: 500, tack: 60000, tock: 90000 };
    const max = N(maxBuyableAcrossPools(growths, item, poolsOf(amounts)));
    expect(max.gt(0)).toBe(true);
    const fits = (n: Decimal) => costLinesToBuyNext(growths, item, NR(n)).every((l) => N(l.cost).lte(amounts[l.currencyCode as keyof typeof amounts]));
    expect(fits(max)).toBe(true);
    expect(fits(max.add(1))).toBe(false);
  });
});
