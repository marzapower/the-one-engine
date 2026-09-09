import type { ProducerCapacity } from "../models/base";
import { type Decimal, N } from "../nums";

/**
 * Pure math behind the saturation rules: how well a producer's stock is
 * supported by its capacity, how a capacity push scales with a driving
 * currency, how an overflow currency drags production down, and how it
 * cools off over real time. None of these functions read state — the engine
 * resolves the inputs from `GameRules` and the entities.
 */
export interface SupportInputs {
  amount: Decimal;
  bought: Decimal;
  capacity: ProducerCapacity;
  capacityMultiplier: Decimal;
  decayExponent: number;
}

/**
 * `raw` is the unsmoothed capacity/amount ratio, clamped to [0,1] — a simple
 * "how full is it" reading. `smooth` is the efficiency actually applied to
 * output: 1 at or below capacity, decaying gradually above it instead of
 * dropping in a step:
 * `smooth = exp(-(log10(amount / capacity) / decayScale) ^ decayExponent)`.
 * Both are 1 when there is no stock yet, both 0 when the capacity itself is
 * non-positive.
 */
export function supportRatio(inputs: SupportInputs): { smooth: Decimal; raw: Decimal } {
  const { amount, bought, capacity, capacityMultiplier, decayExponent } = inputs;
  if (amount.lte(0)) return { smooth: N(1), raw: N(1) };

  const cap = N(capacity.base).mul(N(capacity.factor).pow(bought)).mul(capacityMultiplier);
  if (cap.lte(0)) return { smooth: N(0), raw: N(0) };

  const rawRatio = cap.div(amount);
  const raw = rawRatio.gte(1) ? N(1) : rawRatio.lte(0) ? N(0) : rawRatio;

  if (amount.lte(cap)) return { smooth: N(1), raw };

  const decay = amount.div(cap).log10().div(capacity.decayScale).pow(decayExponent);
  const smooth = N(Math.E).pow(N(0).sub(decay));
  return { smooth, raw };
}

/**
 * Capacity push driven by a currency's stock (typically its lifetime
 * `earned`): every capacity scales by `(1 + earned) ^ exponent`. 1 when
 * `earned` is non-positive, so a fresh game starts unpushed.
 */
export function capacityPush(earned: Decimal, exponent: number): Decimal {
  if (earned.lte(0)) return N(1);
  return earned.add(1).pow(exponent);
}

/**
 * Production slowdown driven by the overflow currency's stock, in decades
 * above `onset`: `factor = max(floor, exp(-((log10(stock) - log10(onset)) / scale) ^ exponent))`.
 * 1 at or below the onset, so the drag stays invisible until the currency
 * actually accumulates.
 */
export function dragFactor(stock: Decimal, drag: { onset: number; scale: number; exponent: number; floor: number }): Decimal {
  if (stock.lte(drag.onset)) return N(1);
  const decades = stock.log10().toNumber() - Math.log10(drag.onset);
  const factor = Math.exp(-Math.pow(decades / drag.scale, drag.exponent));
  return N(Math.max(drag.floor, factor));
}

/**
 * Negative delta to apply to the overflow currency's stock for `elapsedMs`
 * of real-time cooling, linearized (`lambda * dt` stays small at any sane
 * tick length): `stock * -(ln2 / halfLifeMs) * elapsedMs`. 0 without stock.
 */
export function coolingDelta(stock: Decimal, elapsedMs: number, halfLifeMs: number): Decimal {
  if (stock.lte(0)) return N(0);
  const lambdaPerMs = Math.LN2 / halfLifeMs;
  return stock.mul(-lambdaPerMs * elapsedMs);
}
