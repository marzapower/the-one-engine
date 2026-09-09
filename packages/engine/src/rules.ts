/**
 * Optional, data-driven mechanics of a game. Everything here is plain data:
 * a state without `rules` runs producers, upgrades and prestiges and nothing
 * else. Each rule block switches on one mechanic and carries its parameters.
 */

/**
 * Saturation: a producer that declares a `capacity` loses efficiency once its
 * stock exceeds that capacity. The output it loses can overflow into a
 * currency, and that currency can in turn slow every producer down (drag)
 * and decay in real time (cooling).
 */
export interface SaturationRules {
  /**
   * Shape of the efficiency decay above capacity:
   * `efficiency = exp(-(log10(stock / capacity) / decayScale) ^ decayExponent)`.
   * Default 2.
   */
  decayExponent?: number;

  /**
   * Currency that receives the overflow (lost output × the producer's
   * `overflowRate`). Without it the lost output is simply lost.
   */
  overflowCurrencyCode?: string;

  /**
   * Saturation stays inactive until the lifetime `earned` of this currency
   * reaches `earnedAtLeast`. `earned` only grows, so once active it stays so.
   * A missing currency counts as `earned = 0`.
   */
  gate?: { currencyCode: string; earnedAtLeast: number };

  /**
   * Every capacity is multiplied by `(1 + earned) ^ exponent` of this
   * currency (`earned`, falling back to `amount`).
   */
  push?: { currencyCode: string; exponent: number };

  /**
   * The overflow currency stock slows every producer down. Once the stock
   * exceeds `onset`, with `u = log10(stock) - log10(onset)`:
   * `factor = max(floor, exp(-(u / scale) ^ exponent))`.
   * Independent of the gate: it applies whenever the overflow currency exists.
   */
  drag?: { onset: number; scale: number; exponent: number; floor: number };

  /**
   * The overflow currency stock decays with this real-time half-life. Only
   * `amount` cools; the lifetime `earned` accumulator never does. Independent
   * of the gate.
   */
  cooling?: { halfLifeMs: number };
}

export interface GameRules {
  saturation?: SaturationRules;
}
