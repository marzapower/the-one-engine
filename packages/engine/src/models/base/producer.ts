import { type Numerus } from "../../nums";
import type { Buyable, Coded, Growable, Resettable } from "./common";

/** One output of a producer: every unit of the producer adds `persec` of `code` per second. */
export interface ProducerTarget {
  code: string;
  persec: Numerus;

  /**
   * Effective per-second rate after every modifier targeting
   * `produces.*.persec` has been folded onto `persec`. Recomputed by the
   * engine on every tick; `persec` itself is never mutated. Read it with a
   * fallback to `persec`, never write it.
   */
  persecEffective?: Numerus;
}

/**
 * Soft cap on a producer's stock, used by the saturation rules:
 * `capacity = base · factor^bought`, times the saturation push. Output from
 * stock above the capacity loses efficiency (see `SaturationRules`).
 */
export interface ProducerCapacity {
  base: Numerus;
  factor: Numerus;
  /** Decades above capacity that cost one e-fold of efficiency. */
  decayScale: number;
  /** Fraction of the lost output converted into the overflow currency. Default 0. */
  overflowRate?: number;
}

export interface Producer extends Buyable, Growable, Coded, Resettable {
  name: string;
  /** Free label for the host. */
  sub?: string;
  produces: ProducerTarget[];
  priority?: number;
  capacity?: ProducerCapacity;
}
