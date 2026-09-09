import { type Buyable, ScaleOn } from "../models/base";
import { type Decimal, type GenericNumberInput, N, NR, type Numerus } from "../nums";
import { resolveGrowthArgs } from "./growth";
import type { GrowthMethodDef, GrowthRegistry } from "./registries/growth";

interface ResolvedPricing {
  def: GrowthMethodDef;
  base: Numerus;
  coeff: Numerus;
  offset: Numerus;
  C: Numerus;
}

/**
 * Resolves an item's cost curve for pricing: the quantity fed into
 * `resolveGrowthArgs` is `item.bought` on `scaleOn: "self"`, or
 * `otherQuantity` (default 0) on `scaleOn: "other"` — the same resolution
 * `computeGrowthFunction` uses, so pricing and effects agree on `other`.
 */
function resolve(growths: GrowthRegistry, item: Buyable, otherQuantity?: Numerus): ResolvedPricing {
  const def = growths.lookup(item.scaling.func);
  if (!def) {
    throw new Error(`Unknown growth method "${item.scaling.func}"`);
  }

  const quantity = item.scaling.scaleOn === ScaleOn.self ? item.bought : (otherQuantity ?? NR(0));
  const args = resolveGrowthArgs(item.scaling, quantity, def);
  return { def, base: args.base, coeff: args.coeff, offset: args.offset, C: args.quantity };
}

/**
 * Total cost of the next `amount` units of `item`, starting from its
 * current cost-curve position. Uses the method's closed-form sum when
 * available, otherwise sums `compute` term by term.
 */
export function costToBuyNext(growths: GrowthRegistry, item: Buyable, amount: GenericNumberInput, otherQuantity?: Numerus): Numerus {
  const { def, base, coeff, offset, C } = resolve(growths, item, otherQuantity);

  if (def.capabilities.hasClosedFormSum && def.sumToN) {
    return NR(def.sumToN(base, coeff, offset, C, NR(amount)));
  }

  const n = N(amount).toNumber();
  if (n <= 0) return NR(0);

  let sum = N(0);
  for (let i = 0; i < n; i++) {
    sum = sum.add(def.compute(base, coeff, offset, NR(N(C).add(i))));
  }
  return NR(sum);
}

/**
 * Largest number of units of `item` buyable with `pool.amount`, starting
 * from its current cost-curve position. Prefers the method's closed-form
 * maximum, falling back to a binary search over the closed-form sum (or an
 * iterative one when neither is available). Either way the result is
 * checked against `costToBuyNext` and shrunk if it would overshoot the pool
 * — closed forms can drift from the iterative sum at extreme scales.
 */
export function maxBuyableAmount(growths: GrowthRegistry, item: Buyable, pool: { amount: Numerus }, otherQuantity?: Numerus): Numerus {
  const M = N(pool.amount);
  if (M.lte(0)) return NR(0);

  const { def, base, coeff, offset, C } = resolve(growths, item, otherQuantity);

  if (def.capabilities.hasClosedFormNmax && def.maxBuyable) {
    const raw = def.maxBuyable(base, coeff, offset, C, NR(M));
    return enforceInvariant(growths, item, M, raw, otherQuantity);
  }

  const CAP = N(10).pow(12);
  let lo = N(0);
  let hi = N(1);

  while (hi.lte(CAP)) {
    const cost = def.sumToN ? def.sumToN(base, coeff, offset, C, NR(hi)) : N(0);
    if (N(cost).gt(M)) break;
    hi = hi.mul(2);
  }

  if (hi.gt(CAP)) hi = CAP;

  let maxIterations = 64;
  while (lo.lt(hi) && maxIterations > 0) {
    const mid = lo.add(hi.sub(lo).div(2)).floor();
    if (mid.eq(lo)) break;

    const cost = def.sumToN ? def.sumToN(base, coeff, offset, C, NR(mid)) : N(0);
    if (N(cost).lte(M)) {
      lo = mid;
    } else {
      hi = mid.sub(1);
    }

    maxIterations--;
  }

  return enforceInvariant(growths, item, M, NR(lo.floor()), otherQuantity);
}

/**
 * Shrinks a candidate maximum until `costToBuyNext(candidate) <= M`, by
 * binary search in `[0, candidate]`. Guards against closed-form maxima that
 * drift from the iterative/closed-form `costToBuyNext` at extreme scales.
 */
function enforceInvariant(growths: GrowthRegistry, item: Buyable, M: Decimal, candidate: Numerus, otherQuantity?: Numerus): Numerus {
  const hi = N(candidate).floor();
  if (hi.lte(0)) return NR(0);

  const costAtHi = N(costToBuyNext(growths, item, NR(hi), otherQuantity));
  if (costAtHi.lte(M)) return NR(hi);

  const costAt1 = N(costToBuyNext(growths, item, NR(1), otherQuantity));
  if (costAt1.gt(M)) return NR(0);

  let lo = N(1);
  let upper = hi;
  let iter = 0;
  while (lo.lt(upper) && iter < 64) {
    const mid = lo.add(upper.sub(lo).add(1).div(2)).floor();
    if (mid.eq(lo)) break;
    const cost = N(costToBuyNext(growths, item, NR(mid), otherQuantity));
    if (cost.lte(M)) lo = mid;
    else upper = mid.sub(1);
    iter++;
  }
  return NR(lo);
}

/**
 * Purchase quote: total cost and amount. With `amount` given, the cost of
 * buying exactly that many; without it, the maximum buyable with `pool` and
 * its cost (falling back to a quote for 1 unit when nothing is affordable).
 */
export function costToBuy(
  growths: GrowthRegistry,
  item: Buyable,
  pool: { amount: Numerus },
  amount?: GenericNumberInput,
  otherQuantity?: Numerus,
): { cost: Numerus; amount: Numerus } {
  if (amount === undefined) {
    const max = maxBuyableAmount(growths, item, pool, otherQuantity);
    if (N(max).lte(0)) {
      const one = NR(1);
      const nextCost = costToBuyNext(growths, item, one, otherQuantity);
      return { cost: nextCost, amount: one };
    }
    const cost = costToBuyNext(growths, item, max, otherQuantity);
    return { cost, amount: NR(N(max).floor()) };
  }

  const amt = N(amount).floor();
  if (amt.lte(0)) return { cost: NR(0), amount: NR(0) };
  const cost = costToBuyNext(growths, item, amt, otherQuantity);
  return { cost, amount: NR(amt) };
}
