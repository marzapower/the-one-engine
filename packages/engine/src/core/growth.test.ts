import { describe, expect, it } from "vitest";

import type { GrowthFunction } from "../models/base";
import { ScaleOn, ScalingMethod } from "../models/base";
import { N, NR } from "../nums";
import { computeGrowthFunction } from "./growth";
import { GrowthRegistry } from "./registries/growth";

const growths = new GrowthRegistry();

describe("computeGrowthFunction", () => {
  describe("scaleOn self", () => {
    it("linear", () => {
      const func: GrowthFunction = { base: NR(5), coeff: NR(2), scaleOn: ScaleOn.self, func: ScalingMethod.Linear };
      expect(NR(computeGrowthFunction(func, NR(10), growths))).toStrictEqual(NR(25));
    });

    it("linear with offset", () => {
      const func: GrowthFunction = { base: NR(5), coeff: NR(2), offset: NR(77), scaleOn: ScaleOn.self, func: ScalingMethod.Linear };
      expect(NR(computeGrowthFunction(func, NR(10), growths))).toStrictEqual(NR(25 + 77));
    });

    it("geometric", () => {
      const func: GrowthFunction = { base: NR(2), coeff: NR(10), scaleOn: ScaleOn.self, func: ScalingMethod.Geometric };
      expect(NR(computeGrowthFunction(func, NR(10), growths))).toStrictEqual(NR(2e10));
    });

    it("geometric with offset", () => {
      const func: GrowthFunction = { base: NR(2), coeff: NR(10), offset: NR(77), scaleOn: ScaleOn.self, func: ScalingMethod.Geometric };
      expect(NR(computeGrowthFunction(func, NR(10), growths))).toStrictEqual(NR(2e10 + 77));
    });

    it("exponential", () => {
      const func: GrowthFunction = { base: NR(2), coeff: NR(2), scaleOn: ScaleOn.self, func: ScalingMethod.Exponential };
      expect(NR(computeGrowthFunction(func, NR(10), growths))).toStrictEqual(NR(N(2).pow(20)));
    });

    it("exponential with offset", () => {
      const func: GrowthFunction = { base: NR(2), coeff: NR(2), offset: NR(77), scaleOn: ScaleOn.self, func: ScalingMethod.Exponential };
      expect(NR(computeGrowthFunction(func, NR(10), growths))).toStrictEqual(NR(N(2).pow(20).add(77)));
    });

    it("double_exponential", () => {
      const func: GrowthFunction = { base: NR(2), coeff: NR(2), scaleOn: ScaleOn.self, func: ScalingMethod.DoubleExponential };
      expect(NR(computeGrowthFunction(func, NR(10), growths))).toStrictEqual(NR(N(2).pow(N(2).pow(10))));
    });

    it("double_exponential with offset", () => {
      const func: GrowthFunction = { base: NR(2), coeff: NR(2), offset: NR(77), scaleOn: ScaleOn.self, func: ScalingMethod.DoubleExponential };
      expect(NR(computeGrowthFunction(func, NR(10), growths))).toStrictEqual(NR(N(2).pow(N(2).pow(10)).add(77)));
    });
  });

  it("throws for an unknown growth method", () => {
    const func: GrowthFunction = { base: NR(1), coeff: NR(1), scaleOn: ScaleOn.self, func: "unknown_method" };
    expect(() => computeGrowthFunction(func, NR(1), growths)).toThrow('Unknown growth method "unknown_method"');
  });

  it("resolves a custom growth method registered on the given registry", () => {
    const custom = new GrowthRegistry();
    custom.register({
      id: "cubic",
      version: "1.0.0",
      compute: (base, coeff, offset, quantity) => N(base).mul(N(coeff)).mul(N(quantity).pow(3)).add(N(offset)),
      capabilities: { hasClosedFormSum: false, hasClosedFormNmax: false },
    });
    const func: GrowthFunction = { base: NR(2), coeff: NR(3), offset: NR(1), scaleOn: ScaleOn.self, func: "cubic" };
    // Relative tolerance 1e-9: floating-point noise on the last digit, same mathematical value.
    expect(
      computeGrowthFunction(func, NR(4), custom)
        .sub(2 * 3 * 4 ** 3 + 1)
        .abs()
        .lte(1e-9),
    ).toBe(true);
  });
});

/**
 * Parity with the values the engine's previous switch-based implementation
 * produced for every built-in method, both scaleOn modes, and a range of
 * parameters (positive/negative offsets, large quantities). Values are
 * `Decimal.toString()`, compared exactly.
 */
const GOLDEN_GROWTH_FUNCTION: { func: string; scaleOn: ScaleOn; base: string; coeff: string; offset: string; quantity: string; expected: string }[] = [
  // linear
  { func: "linear", scaleOn: ScaleOn.self, base: "10", coeff: "1.2", offset: "0", quantity: "5", expected: "16" },
  { func: "linear", scaleOn: ScaleOn.self, base: "10", coeff: "1.2", offset: "3", quantity: "5", expected: "19" },
  { func: "linear", scaleOn: ScaleOn.self, base: "2", coeff: "3", offset: "1", quantity: "4", expected: "15" },
  { func: "linear", scaleOn: ScaleOn.self, base: "1", coeff: "0.125", offset: "-3.125", quantity: "1e40", expected: "1.2499999999999996e39" },
  { func: "linear", scaleOn: ScaleOn.other, base: "10", coeff: "1.2", offset: "0", quantity: "5", expected: "16" },
  { func: "linear", scaleOn: ScaleOn.other, base: "10", coeff: "1.2", offset: "3", quantity: "5", expected: "19" },
  { func: "linear", scaleOn: ScaleOn.other, base: "2", coeff: "3", offset: "1", quantity: "4", expected: "15" },
  { func: "linear", scaleOn: ScaleOn.other, base: "1", coeff: "0.125", offset: "-3.125", quantity: "1e40", expected: "1.2499999999999996e39" },

  // geometric
  { func: "geometric", scaleOn: ScaleOn.self, base: "10", coeff: "1.2", offset: "0", quantity: "5", expected: "24.8832" },
  { func: "geometric", scaleOn: ScaleOn.self, base: "10", coeff: "1.2", offset: "3", quantity: "5", expected: "27.8832" },
  { func: "geometric", scaleOn: ScaleOn.self, base: "2", coeff: "3", offset: "1", quantity: "4", expected: "163" },
  { func: "geometric", scaleOn: ScaleOn.self, base: "1", coeff: "0.125", offset: "-3.125", quantity: "1e40", expected: "-3.125" },
  { func: "geometric", scaleOn: ScaleOn.other, base: "10", coeff: "1.2", offset: "0", quantity: "5", expected: "68.98648307306074" },
  { func: "geometric", scaleOn: ScaleOn.other, base: "10", coeff: "1.2", offset: "3", quantity: "5", expected: "71.98648307306074" },
  { func: "geometric", scaleOn: ScaleOn.other, base: "2", coeff: "3", offset: "1", quantity: "4", expected: "128.99999999999997" },
  { func: "geometric", scaleOn: ScaleOn.other, base: "1", coeff: "0.125", offset: "-3.125", quantity: "1e40", expected: "99996.875" },

  // exponential
  { func: "exponential", scaleOn: ScaleOn.self, base: "10", coeff: "1.2", offset: "0", quantity: "5", expected: "1000000" },
  { func: "exponential", scaleOn: ScaleOn.self, base: "10", coeff: "1.2", offset: "3", quantity: "5", expected: "1000003" },
  { func: "exponential", scaleOn: ScaleOn.self, base: "2", coeff: "3", offset: "1", quantity: "4", expected: "4096.999999999998" },
  { func: "exponential", scaleOn: ScaleOn.self, base: "1", coeff: "0.125", offset: "-3.125", quantity: "1e40", expected: "-2.125" },
  { func: "exponential", scaleOn: ScaleOn.other, base: "10", coeff: "1.2", offset: "0", quantity: "5", expected: "1000000" },
  { func: "exponential", scaleOn: ScaleOn.other, base: "10", coeff: "1.2", offset: "3", quantity: "5", expected: "1000003" },
  { func: "exponential", scaleOn: ScaleOn.other, base: "2", coeff: "3", offset: "1", quantity: "4", expected: "4096.999999999998" },
  { func: "exponential", scaleOn: ScaleOn.other, base: "1", coeff: "0.125", offset: "-3.125", quantity: "1e40", expected: "-2.125" },

  // double_exponential
  { func: "double_exponential", scaleOn: ScaleOn.self, base: "10", coeff: "1.2", offset: "0", quantity: "5", expected: "307.8364201868885" },
  { func: "double_exponential", scaleOn: ScaleOn.self, base: "10", coeff: "1.2", offset: "3", quantity: "5", expected: "310.8364201868885" },
  { func: "double_exponential", scaleOn: ScaleOn.self, base: "2", coeff: "3", offset: "1", quantity: "4", expected: "2.417851639229265e24" },
  { func: "double_exponential", scaleOn: ScaleOn.self, base: "1", coeff: "0.125", offset: "-3.125", quantity: "1e40", expected: "-2.125" },
  { func: "double_exponential", scaleOn: ScaleOn.other, base: "10", coeff: "1.2", offset: "0", quantity: "5", expected: "7918598.208202989" },
  { func: "double_exponential", scaleOn: ScaleOn.other, base: "10", coeff: "1.2", offset: "3", quantity: "5", expected: "7918601.208202989" },
  { func: "double_exponential", scaleOn: ScaleOn.other, base: "2", coeff: "3", offset: "1", quantity: "4", expected: "1.844674407370941e19" },
  { func: "double_exponential", scaleOn: ScaleOn.other, base: "1", coeff: "0.125", offset: "-3.125", quantity: "1e40", expected: "-2.125" },

  // logarithmic
  { func: "logarithmic", scaleOn: ScaleOn.self, base: "10", coeff: "1.2", offset: "0", quantity: "5", expected: "8.387640052032227" },
  { func: "logarithmic", scaleOn: ScaleOn.self, base: "10", coeff: "1.2", offset: "3", quantity: "5", expected: "11.387640052032227" },
  { func: "logarithmic", scaleOn: ScaleOn.self, base: "2", coeff: "3", offset: "1", quantity: "4", expected: "4.612359947967774" },
  { func: "logarithmic", scaleOn: ScaleOn.self, base: "1", coeff: "0.125", offset: "-3.125", quantity: "1e40", expected: "1.875" },
  { func: "logarithmic", scaleOn: ScaleOn.other, base: "10", coeff: "1.2", offset: "0", quantity: "5", expected: "8.387640052032227" },
  { func: "logarithmic", scaleOn: ScaleOn.other, base: "10", coeff: "1.2", offset: "3", quantity: "5", expected: "11.387640052032227" },
  { func: "logarithmic", scaleOn: ScaleOn.other, base: "2", coeff: "3", offset: "1", quantity: "4", expected: "4.612359947967774" },
  { func: "logarithmic", scaleOn: ScaleOn.other, base: "1", coeff: "0.125", offset: "-3.125", quantity: "1e40", expected: "1.875" },
];

describe("GOLDEN growthFunction parity", () => {
  for (const { func, scaleOn, base, coeff, offset, quantity, expected } of GOLDEN_GROWTH_FUNCTION) {
    it(`${func}/${scaleOn}/b${base}/c${coeff}/o${offset}/x${quantity}`, () => {
      const growthFunc: GrowthFunction = { base: NR(base), coeff: NR(coeff), offset: NR(offset), scaleOn, func };
      expect(computeGrowthFunction(growthFunc, NR(quantity), growths).toString()).toBe(expected);
    });
  }
});
