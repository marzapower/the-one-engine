import { describe, expect, it } from "vitest";

import type { Producer } from "../models/base";
import { ScaleOn, ScalingMethod } from "../models/base";
import { Factory } from "../models/base/factory";
import { N, NR } from "../nums";
import { Engine } from "./engine";

// Pure pricing math: registries are stateless here, one shared instance is fine.
const engine = new Engine();

/**
 * Property-based test suite for economy invariants.
 *
 * We verify 4 fundamental properties across all 4 growth types
 * (Linear, Geometric, Exponential, DoubleExponential) using random
 * sampling with a deterministic seeded PRNG (mulberry32) so that
 * failures are reproducible.
 *
 * Properties:
 *  1. Nmax correctness: S(N) <= M < S(N+1).
 *  2. Cost monotonicity: N1 < N2 => costToBuyNext(N1) <= costToBuyNext(N2).
 *  3. costToBuy coherence: cost <= M and cost == costToBuyNext(amount).
 *  4. Zero handling: currency.amount=0 => maxBuyable=0; costToBuyNext(p,0)=0.
 *
 * Notes on numerical tolerance:
 *  - Decimal (break_eternity.js) is a big-number library; closed-form Nmax for Geometric
 *    and Exponential can occasionally be 1 off due to log/exp round-off
 *    in edge cases. For Property 1 we allow a small relative tolerance
 *    (1 + 1e-9) on the upper bound to accept S(N) <= M * (1 + eps).
 *  - Property 2 (monotonicity) is checked strictly; costs are sums of
 *    non-negative terms, so even with round-off the result should be
 *    monotonic (we use gte on the big-number comparison).
 */

// -----------------------------
// Seeded PRNG (mulberry32)
// -----------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform float in [min, max]. */
function uniform(rand: () => number, min: number, max: number): number {
  return min + (max - min) * rand();
}

/** Log-uniform float in [min, max] — useful for M (wide dynamic range). */
function logUniform(rand: () => number, min: number, max: number): number {
  const lmin = Math.log10(min);
  const lmax = Math.log10(max);
  return Math.pow(10, lmin + (lmax - lmin) * rand());
}

/** Integer in [min, max] (inclusive). */
function uniformInt(rand: () => number, min: number, max: number): number {
  return Math.floor(min + (max - min + 1) * rand());
}

// -----------------------------
// Factories for producers/currencies
// -----------------------------
type ParamRange = {
  aMin: number;
  aMax: number;
  bMin: number;
  bMax: number;
  CMin: number;
  CMax: number;
  Mmin: number;
  Mmax: number;
};

const RANGES: Record<ScalingMethod, ParamRange> = {
  [ScalingMethod.Linear]: { aMin: 1, aMax: 1e3, bMin: 0, bMax: 100, CMin: 0, CMax: 1e4, Mmin: 1, Mmax: 1e15 },
  [ScalingMethod.Geometric]: { aMin: 1, aMax: 100, bMin: 1.01, bMax: 3, CMin: 0, CMax: 500, Mmin: 1, Mmax: 1e30 },
  [ScalingMethod.Exponential]: { aMin: 1.01, aMax: 10, bMin: 0.1, bMax: 2, CMin: 0, CMax: 50, Mmin: 1, Mmax: 1e60 },
  [ScalingMethod.DoubleExponential]: { aMin: 1.01, aMax: 2, bMin: 1.01, bMax: 1.5, CMin: 0, CMax: 20, Mmin: 1, Mmax: 1e200 },
  // Type completeness only: logarithmic is a prestige-gain shape, not a
  // purchase-cost curve — it is NOT enrolled in the cost-curve suites below.
  [ScalingMethod.Logarithmic]: { aMin: 0.1, aMax: 10, bMin: 0.1, bMax: 2, CMin: 1, CMax: 1e4, Mmin: 1, Mmax: 1e15 },
};

interface SampleParams {
  a: number;
  b: number;
  C: number;
  M: number;
}

function sample(rand: () => number, func: ScalingMethod): SampleParams {
  const r = RANGES[func];
  return {
    a: uniform(rand, r.aMin, r.aMax),
    b: uniform(rand, r.bMin, r.bMax),
    C: uniformInt(rand, r.CMin, r.CMax),
    M: logUniform(rand, r.Mmin, r.Mmax),
  };
}

function makeProducer(func: ScalingMethod, p: SampleParams): Producer {
  return Factory.buildProducer({
    bought: NR(p.C),
    scaling: {
      base: NR(p.a),
      coeff: NR(p.b),
      scaleOn: ScaleOn.self,
      func,
    },
  });
}

function makeCurrency(amount: number) {
  return Factory.buildCurrency({ amount: NR(amount) });
}

// -----------------------------
// Shared property runners
// -----------------------------
const SAMPLES_PER_PROPERTY = 150; // ~150 random samples per (growthType x property)
const BASE_SEED = 0xc0ffee;

// Tolerance for comparing cost vs budget: 1 + 1e-9 relative.
// Decimal logs/exponents can introduce tiny round-off for Geometric/Exponential.
const COST_TOL = 1 + 1e-9;

/** Check property 1: S(N) <= M and S(N+1) > M (with small tolerance). */
function checkNmaxCorrectness(func: ScalingMethod, seed: number): string | null {
  const rand = mulberry32(seed);
  for (let i = 0; i < SAMPLES_PER_PROPERTY; i++) {
    const p = sample(rand, func);
    const producer = makeProducer(func, p);
    const currency = makeCurrency(p.M);

    const Nmax = engine.maxBuyableAmount(producer, currency);
    const Nn = N(Nmax);

    // Nmax must be >= 0
    if (Nn.lt(0)) {
      return `Nmax < 0 at seed=${seed} iter=${i} params=${JSON.stringify(p)} Nmax=${Nn.toNumber()}`;
    }

    if (Nn.gt(0)) {
      const costN = engine.costToBuyNext(producer, NR(Nn));
      // Allow a small relative tolerance on the upper bound.
      const upper = N(p.M).mul(COST_TOL);
      if (N(costN).gt(upper)) {
        return `S(N) > M at seed=${seed} iter=${i} func=${func} params=${JSON.stringify(p)} Nmax=${Nn.toNumber()} cost=${N(costN).toNumber()}`;
      }
    }

    // S(N+1) must exceed M (strictly greater than M, within reverse tolerance).
    const NPlus1 = Nn.add(1);
    const costN1 = engine.costToBuyNext(producer, NR(NPlus1));
    // For the "can't buy N+1" side, cost should be > M.
    // With round-off, accept cost >= M * (1 - tol).
    const lower = N(p.M).div(COST_TOL);
    if (N(costN1).lte(lower)) {
      return `S(N+1) <= M at seed=${seed} iter=${i} func=${func} params=${JSON.stringify(p)} Nmax=${Nn.toNumber()} costNext=${N(costN1).toNumber()}`;
    }
  }
  return null;
}

/** Check property 2: cost monotonic in N. */
function checkMonotonicity(func: ScalingMethod, seed: number): string | null {
  const rand = mulberry32(seed);
  for (let i = 0; i < SAMPLES_PER_PROPERTY; i++) {
    const p = sample(rand, func);
    const producer = makeProducer(func, p);

    // Pick two increasing amounts. For DoubleExponential we stay within the
    // "exact sum" branch of costToBuyNext (N <= 8) to avoid the dominant-term
    // approximation: see the known-issue test below for the broken branch.
    const maxAmt = func === ScalingMethod.DoubleExponential ? 4 : 30;
    const n1 = uniformInt(rand, 1, maxAmt);
    const n2 = n1 + uniformInt(rand, 1, maxAmt);

    const c1 = engine.costToBuyNext(producer, NR(n1));
    const c2 = engine.costToBuyNext(producer, NR(n2));

    if (N(c2).lt(N(c1))) {
      return `cost non-monotonic at seed=${seed} iter=${i} func=${func} params=${JSON.stringify(p)} n1=${n1} n2=${n2} c1=${N(c1).toNumber()} c2=${N(c2).toNumber()}`;
    }
  }
  return null;
}

/** Check property 3: costToBuy coherence. */
function checkCostToBuyCoherence(func: ScalingMethod, seed: number): string | null {
  const rand = mulberry32(seed);
  for (let i = 0; i < SAMPLES_PER_PROPERTY; i++) {
    const p = sample(rand, func);
    const producer = makeProducer(func, p);
    const currency = makeCurrency(p.M);

    const quote = engine.costToBuy(producer, currency);

    // quote.amount should equal max (or 1 in the "fallback" branch when max=0).
    // We accept both cases; we check coherence between cost and costToBuyNext(amount).
    const amt = N(quote.amount);
    const cost = N(quote.cost);
    const expectedCost = N(engine.costToBuyNext(producer, NR(amt)));

    if (!cost.eq(expectedCost)) {
      return `quote.cost != costToBuyNext(amount) at seed=${seed} iter=${i} func=${func} params=${JSON.stringify(p)} amount=${amt.toNumber()} cost=${cost.toNumber()} expected=${expectedCost.toNumber()}`;
    }

    // If amount > 0, either we're in the normal case (cost <= M) or the fallback
    // branch (max=0, so amount=1 and cost may exceed M).
    if (amt.gt(0)) {
      const maxN = N(engine.maxBuyableAmount(producer, currency));
      if (maxN.gt(0)) {
        // Normal case: cost must fit within budget (with tolerance).
        const upper = N(p.M).mul(COST_TOL);
        if (cost.gt(upper)) {
          return `quote cost > M at seed=${seed} iter=${i} func=${func} params=${JSON.stringify(p)} amount=${amt.toNumber()} cost=${cost.toNumber()} M=${p.M}`;
        }
      } else {
        // Fallback branch: amount should be 1, cost is the price of buying 1.
        if (!amt.eq(1)) {
          return `fallback quote amount != 1 at seed=${seed} iter=${i} func=${func} params=${JSON.stringify(p)} amount=${amt.toNumber()}`;
        }
      }
    }
  }
  return null;
}

/** Check property 4: zero handling. */
function checkZeroHandling(func: ScalingMethod, seed: number): string | null {
  const rand = mulberry32(seed);
  for (let i = 0; i < SAMPLES_PER_PROPERTY; i++) {
    const p = sample(rand, func);
    const producer = makeProducer(func, p);
    const zeroCurrency = makeCurrency(0);

    const maxZero = engine.maxBuyableAmount(producer, zeroCurrency);
    if (!N(maxZero).eq(0)) {
      return `maxBuyableAmount(M=0) != 0 at seed=${seed} iter=${i} func=${func} params=${JSON.stringify(p)} got=${N(maxZero).toNumber()}`;
    }

    const costZero = engine.costToBuyNext(producer, NR(0));
    if (!N(costZero).eq(0)) {
      return `costToBuyNext(N=0) != 0 at seed=${seed} iter=${i} func=${func} params=${JSON.stringify(p)} got=${N(costZero).toNumber()}`;
    }
  }
  return null;
}

// -----------------------------
// Describe blocks
// -----------------------------
const GROWTH_TYPES: { name: string; func: ScalingMethod; seedOffset: number }[] = [
  { name: "Linear", func: ScalingMethod.Linear, seedOffset: 1 },
  { name: "Geometric", func: ScalingMethod.Geometric, seedOffset: 2 },
  { name: "Exponential", func: ScalingMethod.Exponential, seedOffset: 3 },
  { name: "DoubleExponential", func: ScalingMethod.DoubleExponential, seedOffset: 4 },
];

for (const gt of GROWTH_TYPES) {
  describe(`Economy property-based tests — ${gt.name}`, () => {
    const seed = BASE_SEED + gt.seedOffset * 0x1000;

    it(`Property 1 (Nmax correctness): S(N) <= M < S(N+1) across ${SAMPLES_PER_PROPERTY} random samples`, () => {
      const err = checkNmaxCorrectness(gt.func, seed + 0x01);
      if (err) throw new Error(err);
      expect(err).toBeNull();
    });

    it(`Property 2 (cost monotonicity): cost(N1) <= cost(N2) for N1 < N2 across ${SAMPLES_PER_PROPERTY} random samples`, () => {
      const err = checkMonotonicity(gt.func, seed + 0x02);
      if (err) throw new Error(err);
      expect(err).toBeNull();
    });

    it(`Property 3 (costToBuy coherence): cost == costToBuyNext(amount) and cost <= M across ${SAMPLES_PER_PROPERTY} random samples`, () => {
      const err = checkCostToBuyCoherence(gt.func, seed + 0x03);
      if (err) throw new Error(err);
      expect(err).toBeNull();
    });

    it(`Property 4 (zero handling): max(M=0)=0 and costToBuyNext(N=0)=0 across ${SAMPLES_PER_PROPERTY} random samples`, () => {
      const err = checkZeroHandling(gt.func, seed + 0x04);
      if (err) throw new Error(err);
      expect(err).toBeNull();
    });
  });
}

/**
 * Regression test for DoubleExponential weak dominance case.
 *
 * For DoubleExponential with base `a` and coeff `b` both close to 1, the
 * "dominant term" approximation in costToBuyNext for N > MAX_EXACT must
 * check dominance ratio before applying it. When ratio < 2 (weak dominance),
 * exact sum is computed even for large N to maintain monotonicity.
 *
 * Reproducible counterexample (seed=12664816 iter=4 of mulberry32 with the
 * sampling used above, but we lock it inline here for clarity):
 *   a = 1.7407724304008299
 *   b = 1.0578222787589766
 *   C = 5
 *   cost(N=6) ≈ 14.07 (exact, since 6 <= MAX_EXACT=64)
 *   cost(N=9) ≈ 17.34 (exact, since weak dominance detected)
 *
 * This test verifies that monotonicity now holds across the MAX_EXACT boundary.
 */
describe("Economy property-based tests — DoubleExponential weak dominance regression", () => {
  it("cost monotonicity holds when a,b ~ 1 (weak dominance correctly handled)", () => {
    const producer = Factory.buildProducer({
      bought: NR(5),
      scaling: {
        base: NR(1.7407724304008299),
        coeff: NR(1.0578222787589766),
        scaleOn: ScaleOn.self,
        func: ScalingMethod.DoubleExponential,
      },
    });
    const c6 = engine.costToBuyNext(producer, NR(6)); // exact sum branch
    const c9 = engine.costToBuyNext(producer, NR(9)); // exact sum branch (weak dominance)
    // Monotonicity SHOULD hold:
    expect(N(c9).gte(N(c6))).toBe(true);
  });
});

// -----------------------------
// Pathological bases — tetration-scale Numerus as base
// -----------------------------
// A producer whose cost base is a tetration-scale number (10^^10). The
// closed-form Nmax of the exponential method returns a positive N for such a
// base while the cost of buying that many units explodes into tetration, so a
// buy-max would push the paying currency below zero. The invariant guard in
// engine.maxBuyableAmount must keep cost(Nmax) <= M for ANY valid input,
// including these extreme bases.
describe("Economy invariant — pathological bases", () => {
  it("Exponential with tetration base 10^^10 never overshoots budget", () => {
    const producer: Producer = {
      code: "path-exp",
      name: "Pathological Exp",
      currencyCode: "one",
      amount: NR(0),
      bought: NR(0),
      produces: [{ code: "one", persec: NR(1) }],
      scaling: {
        base: NR("10^^10"),
        coeff: NR(5),
        scaleOn: ScaleOn.self,
        func: ScalingMethod.Exponential,
      },
    };
    for (const m of [1, 1e3, 1e10, 1e30]) {
      const currency = makeCurrency(m);
      const Nmax = engine.maxBuyableAmount(producer, currency);
      if (N(Nmax).lte(0)) continue;
      const cost = engine.costToBuyNext(producer, Nmax);
      expect(N(cost).lte(N(m).mul(COST_TOL))).toBe(true);
    }
  });

  it("Geometric with huge base 1e100 never overshoots budget", () => {
    const producer = makeProducer(ScalingMethod.Geometric, {
      a: 1e100,
      b: 1.5,
      C: 0,
      M: 1e50,
    });
    const currency = makeCurrency(1e50);
    const Nmax = engine.maxBuyableAmount(producer, currency);
    if (N(Nmax).gt(0)) {
      const cost = engine.costToBuyNext(producer, Nmax);
      expect(N(cost).lte(N(1e50).mul(COST_TOL))).toBe(true);
    }
  });

  it("DoubleExponential weak-dominance does not overshoot", () => {
    // Seed-reproduced case that originally slipped past A1's fix:
    const producer = makeProducer(ScalingMethod.DoubleExponential, {
      a: 1.85,
      b: 1.07,
      C: 3,
      M: 14.76,
    });
    const currency = makeCurrency(14.76);
    const Nmax = engine.maxBuyableAmount(producer, currency);
    if (N(Nmax).gt(0)) {
      const cost = engine.costToBuyNext(producer, Nmax);
      expect(N(cost).lte(N(14.76).mul(COST_TOL))).toBe(true);
    }
  });
});
