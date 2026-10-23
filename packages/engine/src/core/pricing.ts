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
function resolve(growths: GrowthRegistry, item: Pick<Buyable, "bought" | "scaling">, otherQuantity?: Numerus): ResolvedPricing {
  const def = growths.lookup(item.scaling.func);
  if (!def) {
    throw new Error(`Unknown growth method "${item.scaling.func}"`);
  }

  const quantity = item.scaling.scaleOn === ScaleOn.self ? item.bought : (otherQuantity ?? NR(0));
  const args = resolveGrowthArgs(item.scaling, quantity, def);
  return { def, base: args.base, coeff: args.coeff, offset: args.offset, C: args.quantity };
}

/** Item shape the single-curve pricing functions need: a position and a curve. */
type Priced = Pick<Buyable, "bought" | "scaling">;

/**
 * Total cost of the next `amount` units of `item`, starting from its
 * current cost-curve position. Main cost only: items with `extraCosts` go
 * through `costLinesToBuyNext`. Uses the method's closed-form sum when
 * available, otherwise sums `compute` term by term.
 */
export function costToBuyNext(growths: GrowthRegistry, item: Priced, amount: GenericNumberInput, otherQuantity?: Numerus): Numerus {
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
 * from its current cost-curve position. Main cost only: items with
 * `extraCosts` go through `maxBuyableAcrossPools`. Prefers the method's closed-form
 * maximum, falling back to a binary search over the closed-form sum (or an
 * iterative one when neither is available). Either way the result is
 * checked against `costToBuyNext` and shrunk if it would overshoot the pool
 * — closed forms can drift from the iterative sum at extreme scales.
 */
export function maxBuyableAmount(growths: GrowthRegistry, item: Priced, pool: { amount: Numerus }, otherQuantity?: Numerus): Numerus {
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
function enforceInvariant(growths: GrowthRegistry, item: Priced, M: Decimal, candidate: Numerus, otherQuantity?: Numerus): Numerus {
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
 * Main cost only: items with `extraCosts` go through `costLinesToBuyNext`.
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

/** One pool's share of a purchase: the pool code and what it pays. */
export interface CostLine {
  currencyCode: string;
  cost: Numerus;
}

/**
 * Cost of the next `amount` units, pool by pool: the main line first, then
 * each extra in definition order. An extra whose `fromBought` leaves the whole
 * span free is omitted. `amount <= 0` gives `[]`. `otherQuantity` is forwarded
 * unchanged to every line (`scaleOn: "other"`), with no bulk/single
 * equivalence promised for it.
 */
export function costLinesToBuyNext(growths: GrowthRegistry, item: Buyable, amount: GenericNumberInput, otherQuantity?: Numerus): CostLine[] {
  const n = N(amount);
  if (n.isNan() || n.lte(0)) return [];

  const lines: CostLine[] = [{ currencyCode: item.currencyCode, cost: costToBuyNext(growths, item, amount, otherQuantity) }];
  const b = N(item.bought);
  for (const extra of item.extraCosts ?? []) {
    const skip = freePositions(b, extra).min(n);
    const paid = n.sub(skip);
    if (paid.lte(0)) continue;
    lines.push({ currencyCode: extra.currencyCode, cost: costToBuyNext(growths, { bought: NR(b.add(skip)), scaling: extra.scaling }, NR(paid), otherQuantity) });
  }
  return lines;
}

/** Positions below `extra.fromBought` that are still ahead of `bought`: `ceil(max(0, fromBought - bought))`, in Decimal. */
function freePositions(bought: Decimal, extra: { fromBought?: number }): Decimal {
  return N(extra.fromBought ?? 0)
    .sub(bought)
    .max(0)
    .ceil();
}

/**
 * Largest number of units whose every line fits its pool: the minimum over
 * the main cost and each extra. A missing pool (`poolOf` gives `undefined`)
 * gives 0. Exact for non-negative cost curves with a reliable sum (each line
 * is monotone in the number of units).
 *
 * An economic bound only: it ignores `max` and `unlock`. A purchase still goes
 * through the `*PurchaseBlock` checks.
 */
export function maxBuyableAcrossPools(growths: GrowthRegistry, item: Buyable, poolOf: (code: string) => { amount: Numerus } | undefined, otherQuantity?: Numerus): Numerus {
  const mainPool = poolOf(item.currencyCode);
  if (!mainPool) return NR(0);
  let result = N(maxBuyableAmount(growths, item, mainPool, otherQuantity));

  const b = N(item.bought);
  for (const extra of item.extraCosts ?? []) {
    const pool = poolOf(extra.currencyCode);
    if (!pool) return NR(0);
    const free = freePositions(b, extra);
    const affordable = free.add(N(maxBuyableAmount(growths, { bought: NR(b.add(free)), scaling: extra.scaling }, pool, otherQuantity)));
    result = result.min(affordable);
  }
  return NR(result);
}
