import { describe, expect, it } from "vitest";

import { N, NR } from "../nums";
import {
  doubleExponentialCompute,
  doubleExponentialMaxBuyable,
  doubleExponentialSumToN,
  exponentialCompute,
  exponentialMaxBuyable,
  exponentialSumToN,
  geometricCompute,
  geometricMaxBuyable,
  geometricSumToN,
  linearCompute,
  linearMaxBuyable,
  linearSumToN,
  logarithmicCompute,
} from "./growth-formulas";

const closeEnough = (a: unknown, b: unknown): boolean =>
  N(a as never)
    .sub(N(b as never))
    .abs()
    .lte(1e-9);

describe("built-in growth formulas", () => {
  describe("compute includes offset", () => {
    it("linear", () => {
      expect(N(linearCompute(NR(10), NR(1.2), NR(3), NR(5))).toNumber()).toBeCloseTo(10 + 1.2 * 5 + 3, 9);
    });

    it("geometric", () => {
      expect(N(geometricCompute(NR(10), NR(1.2), NR(3), NR(5))).toNumber()).toBeCloseTo(10 * 1.2 ** 5 + 3, 9);
    });

    it("exponential", () => {
      expect(N(exponentialCompute(NR(10), NR(1.2), NR(3), NR(5))).toNumber()).toBeCloseTo(10 ** (1.2 * 5) + 3, 9);
    });

    it("double_exponential", () => {
      expect(N(doubleExponentialCompute(NR(2), NR(1.2), NR(3), NR(5))).toNumber()).toBeCloseTo(2 ** (1.2 ** 5) + 3, 9);
    });
  });

  // sumToN(base, coeff, offset, C, 1) equals compute(base, coeff, offset, C) for every
  // built-in with a closed-form sum, with a non-zero offset.
  describe("sumToN(C, 1) equals compute(C) with offset != 0", () => {
    it("linear", () => {
      const computed = linearCompute(NR(10), NR(1.2), NR(3), NR(7));
      const summed = linearSumToN(NR(10), NR(1.2), NR(3), NR(7), NR(1));
      expect(closeEnough(computed, summed)).toBe(true);
    });

    it("geometric", () => {
      const computed = geometricCompute(NR(10), NR(1.2), NR(3), NR(7));
      const summed = geometricSumToN(NR(10), NR(1.2), NR(3), NR(7), NR(1));
      expect(closeEnough(computed, summed)).toBe(true);
    });

    it("exponential", () => {
      const computed = exponentialCompute(NR(10), NR(1.2), NR(3), NR(7));
      const summed = exponentialSumToN(NR(10), NR(1.2), NR(3), NR(7), NR(1));
      expect(closeEnough(computed, summed)).toBe(true);
    });

    it("double_exponential", () => {
      const computed = doubleExponentialCompute(NR(2), NR(1.2), NR(3), NR(7));
      const summed = doubleExponentialSumToN(NR(2), NR(1.2), NR(3), NR(7), NR(1));
      expect(closeEnough(computed, summed)).toBe(true);
    });
  });

  describe("maxBuyable respects the budget", () => {
    it("linear", () => {
      const n = linearMaxBuyable(NR(10), NR(5), NR(0), NR(0), NR(101));
      expect(n).toStrictEqual(NR(5));
    });

    it("geometric", () => {
      const n = geometricMaxBuyable(NR(10), NR(1.15), NR(0), NR(0), NR(1e6));
      const spent = geometricSumToN(NR(10), NR(1.15), NR(0), NR(0), NR(n));
      const nextOne = geometricSumToN(NR(10), NR(1.15), NR(0), NR(0), NR(N(n).add(1)));
      expect(N(spent).lte(1e6)).toBe(true);
      expect(N(nextOne).gt(1e6)).toBe(true);
    });

    it("exponential", () => {
      const n = exponentialMaxBuyable(NR(1.5), NR(1), NR(0), NR(0), NR(1e6));
      const spent = exponentialSumToN(NR(1.5), NR(1), NR(0), NR(0), NR(n));
      expect(N(spent).lte(1e6)).toBe(true);
    });

    it("double_exponential", () => {
      const n = doubleExponentialMaxBuyable(NR(2), NR(1.2), NR(0), NR(0), NR(1e12));
      const spent = doubleExponentialSumToN(NR(2), NR(1.2), NR(0), NR(0), NR(n));
      expect(N(spent).lte(1e12)).toBe(true);
    });
  });

  describe("logarithmic", () => {
    it("returns the offset at and below 0", () => {
      expect(logarithmicCompute(NR(10), NR(1.2), NR(3), NR(0))).toStrictEqual(N(3));
      expect(logarithmicCompute(NR(10), NR(1.2), NR(3), NR(-5))).toStrictEqual(N(3));
    });

    it("grows linearly in the decades of the quantity", () => {
      const at10 = N(logarithmicCompute(NR(10), NR(1.2), NR(0), NR(10)));
      const at100 = N(logarithmicCompute(NR(10), NR(1.2), NR(0), NR(100)));
      expect(closeEnough(at100.sub(at10), N(10).mul(1.2))).toBe(true);
    });
  });
});
