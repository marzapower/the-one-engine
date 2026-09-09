import { type Numerus } from "../../nums";
import { type Coded, type Growable, type Ownable, type Resettable } from "./common";

/**
 * Which stock of a prestige currency drives the passive effects of the
 * prestiges paid in it: `drive = amount · unspentWeight + earned · earnedWeight`.
 * The weights are meant to sum to 1. Default `{ unspentWeight: 0, earnedWeight: 1 }`:
 * spending the currency never weakens the passive effects.
 */
export interface PrestigeDrive {
  unspentWeight: number;
  earnedWeight: number;
}

export interface Currency extends Ownable, Growable, Coded, Resettable {
  name: string;

  /**
   * Marks the currency the game is about, the one a rational player
   * maximizes. The balance tools anchor their value model on it. Exactly one
   * currency per game should set it.
   */
  primary?: boolean;

  /**
   * Lifetime earned total. Prestige conversions and overflow accumulate it;
   * resets and cooling never touch it. Passive prestige effects and the
   * saturation gate and push read this instead of `amount`.
   */
  earned?: Numerus;

  /** See `PrestigeDrive`. Meaningful on prestige currencies only. */
  drive?: PrestigeDrive;

  /**
   * Capacity channel (meaningful on the saturation overflow currency, base 1):
   * effects targeting `capacityMult` fold onto this value, and the result
   * multiplies every producer capacity. Never written by effects.
   */
  capacityMult?: Numerus;

  /**
   * Prestige-gain channel (meaningful on a prestige currency, base 1): effects
   * targeting `gainMult` fold onto this value, and the result multiplies the
   * delivered prestige gain. Never written by effects.
   */
  gainMult?: Numerus;

  /**
   * Cooling channel (meaningful on the saturation overflow currency, base 1):
   * effects targeting `coolingMult` fold onto this value, and the result
   * multiplies the currency's real-time decay rate. Never written by effects.
   */
  coolingMult?: Numerus;
}
