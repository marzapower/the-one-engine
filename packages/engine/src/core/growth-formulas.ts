import { type Decimal, N, NR, type Numerus } from "../nums";

/**
 * Built-in growth formulas: the `compute`/`sumToN`/`maxBuyable` triples
 * behind the registry's built-in growth methods (`GrowthRegistry`). Each
 * triple is pure and independent of any entity shape — callers resolve
 * `base`, `coeff`, `offset` and the variable quantity before calling in.
 */

/** Linear: F(x) = base + coeff · x + offset */
export function linearCompute(base: Numerus, coeff: Numerus, offset: Numerus, quantity: Numerus): Decimal {
  return N(base)
    .add(N(coeff).mul(N(quantity)))
    .add(N(offset));
}

/** Linear closed-form sum: S(N) = (base + coeff·C)·N + coeff·N·(N-1)/2 + offset·N */
export function linearSumToN(base: Numerus, coeff: Numerus, offset: Numerus, C: Numerus, N_: Numerus): Decimal {
  const a = N(base);
  const b = N(coeff);
  const C_num = N(C);
  const N_num = N(N_);
  const q = N(offset);

  const firstTerm = a.add(b.mul(C_num)).mul(N_num);
  const secondTerm = b.mul(N_num).mul(N_num.sub(1)).div(2);
  const offsetTerm = q.mul(N_num);

  return firstTerm.add(secondTerm).add(offsetTerm);
}

/**
 * Linear maximum buyable: the largest N with S(N) <= M, starting from C.
 * Solves the quadratic coeff/2·N^2 + (base + coeff·C - coeff/2)·N - M <= 0.
 */
export function linearMaxBuyable(base: Numerus, coeff: Numerus, offset: Numerus, C: Numerus, M: Numerus): Numerus {
  const a = N(base);
  const b = N(coeff);
  const C_num = N(C);
  const M_num = N(M);

  if (M_num.lte(0)) return NR(0);

  // Constant cost per item when coeff = 0.
  if (b.eq(0)) {
    if (a.lte(0)) return NR(0);
    return NR(M_num.div(a).floor());
  }

  // Quadratic formula: B = base + coeff·C - coeff/2, discriminant = B^2 + 2·coeff·M
  const B = a.add(b.mul(C_num)).sub(b.div(2));
  const discriminant = B.pow(2).add(b.mul(M_num).mul(2));

  if (discriminant.lte(0)) {
    return NR(0);
  }

  const sqrtDiscriminant = discriminant.sqrt();
  const numerator = sqrtDiscriminant.sub(B);

  if (numerator.lte(0)) {
    return NR(0);
  }

  return NR(numerator.div(b).floor());
}

/** Geometric: F(x) = base · coeff^x + offset */
export function geometricCompute(base: Numerus, coeff: Numerus, offset: Numerus, quantity: Numerus): Decimal {
  return N(base)
    .mul(N(coeff).pow(N(quantity)))
    .add(N(offset));
}

/**
 * Geometric closed-form sum: S(N) = base·coeff^C · (1 - coeff^N) / (1 - coeff) + offset·N.
 * Degenerates to a plain multiple of the first term when coeff = 1.
 */
export function geometricSumToN(base: Numerus, coeff: Numerus, offset: Numerus, C: Numerus, N_: Numerus): Decimal {
  const a = N(base);
  const b = N(coeff);
  const C_num = N(C);
  const N_num = N(N_);
  const q = N(offset);

  const A = a.mul(b.pow(C_num));

  if (b.eq(1)) {
    return A.mul(N_num).add(q.mul(N_num));
  }

  return A.mul(N(1).sub(b.pow(N_num)))
    .div(N(1).sub(b))
    .add(q.mul(N_num));
}

/** Geometric maximum buyable: the largest N with S(N) <= M, starting from C. */
export function geometricMaxBuyable(base: Numerus, coeff: Numerus, _offset: Numerus, C: Numerus, M: Numerus): Numerus {
  const a = N(base);
  const b = N(coeff);
  const C_num = N(C);
  const M_num = N(M);

  if (M_num.lte(0)) return NR(0);

  const A = a.mul(b.pow(C_num));

  if (b.eq(1)) {
    return NR(M_num.div(A).floor());
  }

  return NR(M_num.div(A).mul(b.sub(1)).add(1).log10().div(b.log10()).floor());
}

/** Exponential: F(x) = base^(coeff·x) + offset */
export function exponentialCompute(base: Numerus, coeff: Numerus, offset: Numerus, quantity: Numerus): Decimal {
  return N(base)
    .pow(N(coeff).mul(N(quantity)))
    .add(N(offset));
}

/** Exponential closed-form sum: S(N) = base^(coeff·C) · (1 - base^(coeff·N)) / (1 - base^coeff) + offset·N */
export function exponentialSumToN(base: Numerus, coeff: Numerus, offset: Numerus, C: Numerus, N_: Numerus): Decimal {
  const a = N(base);
  const b = N(coeff);
  const C_num = N(C);
  const N_num = N(N_);
  const q = N(offset);

  const A = a.pow(b.mul(C_num));
  const R = a.pow(b);

  if (R.eq(1)) {
    return A.mul(N_num).add(q.mul(N_num));
  }

  return A.mul(N(1).sub(R.pow(N_num)))
    .div(N(1).sub(R))
    .add(q.mul(N_num));
}

/** Exponential maximum buyable: the largest N with S(N) <= M, starting from C. */
export function exponentialMaxBuyable(base: Numerus, coeff: Numerus, _offset: Numerus, C: Numerus, M: Numerus): Numerus {
  const a = N(base);
  const b = N(coeff);
  const C_num = N(C);
  const M_num = N(M);

  if (M_num.lte(0)) return NR(0);

  const A = a.pow(b.mul(C_num));
  const R = a.pow(b);

  if (R.eq(1)) {
    return NR(M_num.div(A).floor());
  }

  const rhs = N(1).add(M_num.mul(R.sub(1)).div(A));
  if (rhs.lte(1)) return NR(0);

  return NR(rhs.log10().div(R.log10()).floor());
}

/**
 * Logarithmic: F(x) = base · coeff · log10(x) + offset. Grows linearly in
 * the decades of x — the shape of a prestige conversion, where a currency
 * stays proportionally as hard to earn at every scale. x <= 0 returns just
 * the offset: no closed-form sum or maximum (it is not a cost curve).
 */
export function logarithmicCompute(base: Numerus, coeff: Numerus, offset: Numerus, quantity: Numerus): Decimal {
  const q = N(quantity);
  if (q.lte(0)) return N(offset);
  return N(base).mul(N(coeff)).mul(q.log10()).add(N(offset));
}

/** Double exponential: F(x) = base^(coeff^x) + offset */
export function doubleExponentialCompute(base: Numerus, coeff: Numerus, offset: Numerus, quantity: Numerus): Decimal {
  return N(base)
    .pow(N(coeff).pow(N(quantity)))
    .add(N(offset));
}

/**
 * Double-exponential closed-form sum: S(N) = sum_{k=0..N-1} base^(coeff^(C+k)) + offset·N.
 * Exact for up to 256 terms; beyond that, when the last term dominates the
 * sum strongly enough (ratio to the second-to-last >= 2.5) the sum is
 * approximated by its last term, since the earlier terms are negligible at
 * this method's scale. Hard-capped at 5000 terms.
 */
export function doubleExponentialSumToN(base: Numerus, coeff: Numerus, offset: Numerus, C: Numerus, N_: Numerus): Decimal {
  const a = N(base);
  const b = N(coeff);
  const C_num = N(C);
  const N_num = N(N_).floor();
  const q = N(offset);

  if (N_num.lte(0)) return q.mul(N_num);

  if (a.lte(0) || b.lte(0)) return q.mul(N_num);
  if (a.eq(1)) return N_num.add(q.mul(N_num));
  if (b.eq(1)) return a.mul(N_num).add(q.mul(N_num));

  const count = N_num.toNumber();
  const MAX_EXACT = 256;

  if (count > 5000) {
    const expLast = b.pow(C_num.add(N_num).sub(1));
    const lastTerm = a.pow(expLast);
    return lastTerm.add(q.mul(N_num));
  }

  if (count <= MAX_EXACT) {
    let sum = N(0);
    for (let i = 0; i < count; i++) {
      const exp = b.pow(C_num.add(i));
      const term = a.pow(exp);
      sum = sum.add(term);
    }
    return sum.add(q.mul(N_num));
  }

  const expSecondLast = b.pow(C_num.add(N_num).sub(2));
  const expLast = b.pow(C_num.add(N_num).sub(1));
  const secondLastTerm = a.pow(expSecondLast);
  const lastTerm = a.pow(expLast);
  const ratio = lastTerm.div(secondLastTerm);

  if (ratio.gte(2.5)) {
    return lastTerm.add(q.mul(N_num));
  } else {
    let sum = N(0);
    for (let i = 0; i < count; i++) {
      const exp = b.pow(C_num.add(i));
      const term = a.pow(exp);
      sum = sum.add(term);
    }
    return sum.add(q.mul(N_num));
  }
}

/**
 * Double-exponential maximum buyable: estimates N from a double-logarithm of
 * the budget, then verifies it against `doubleExponentialSumToN` and
 * decrements until the sum fits the budget (within a small floating-point
 * tolerance).
 */
export function doubleExponentialMaxBuyable(base: Numerus, coeff: Numerus, _offset: Numerus, C: Numerus, M: Numerus): Numerus {
  const a = N(base);
  const b = N(coeff);
  const C_num = N(C);
  const M_num = N(M);

  if (M_num.lte(0)) return NR(0);
  if (a.eq(1)) return NR(M_num.floor());
  if (b.eq(1)) return NR(M_num.div(a).floor());
  if (a.lte(0) || b.lte(0)) return NR(0);

  const t1 = M_num.log10().div(a.log10());
  if (t1.lte(0)) return NR(0);

  const LB = t1.log10().div(b.log10());
  let N0 = LB.sub(C_num).add(1).floor();
  if (N0.lte(0)) return NR(0);

  // Conservative check: base^(coeff^(C+N0-1)) must stay within t1.
  const expFor = (n: Decimal) => b.pow(C_num.add(n).sub(1));
  let adjust = 0;
  const MAX_ADJUST = 20;
  while (N0.gt(0) && expFor(N0).gt(t1) && adjust < MAX_ADJUST) {
    N0 = N0.sub(1).floor();
    adjust++;
  }

  // When base and coeff are close to 1 the sum can be much larger than its
  // last term alone, so the check above is not enough: decrement N0 until
  // the exact sum fits the budget, with a small floating-point tolerance.
  const tolerance = M_num.mul(100001).div(100000);
  let verifyGuard = 0;
  const VERIFY_MAX = 40;
  while (N0.gt(0) && verifyGuard < VERIFY_MAX) {
    const costN0 = doubleExponentialSumToN(base, coeff, NR(0), C, NR(N0));
    if (costN0.lte(tolerance)) break;
    N0 = N0.sub(1);
    verifyGuard++;
  }

  return NR(N0);
}
