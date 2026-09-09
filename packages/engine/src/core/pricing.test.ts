import { describe, expect, it } from "vitest";

import { ScaleOn, ScalingMethod } from "../models/base";
import { Factory } from "../models/base/factory";
import { type GenericNumberInput, N, NR } from "../nums";
import { computeGrowthFunction } from "./growth";
import { costToBuy, costToBuyNext, maxBuyableAmount } from "./pricing";
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
