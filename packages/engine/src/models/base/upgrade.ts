import { type Buyable, type Coded, type Effect, type Resettable } from "./common";

/**
 * Behaviours an upgrade switches on while `bought >= 1`. They run in the
 * automation stage (autobuy, drip, auto-prestige, in that order) or during a
 * prestige (keep levels). Every behaviour that names a `prestigeCode` is
 * ignored when that prestige does not exist.
 */
export type UpgradeBehavior =
  /**
   * Each tick buys one level of every upgrade that a prestige resets
   * (`prestigeCode` restricts it to the upgrades resetting on that prestige),
   * paying from the upgrade's own cost pool and respecting `max`.
   */
  | { kind: "autobuyUpgrades"; prestigeCode?: string; upgradeCodes?: string[] }
  /**
   * Every second grants `ratePerSecond · level` of the gain the prestige would
   * deliver right now to the prestige currency (`amount` and `earned`).
   */
  | { kind: "prestigeDrip"; prestigeCode: string; ratePerSecond: number }
  /**
   * With `rule: "ratio"` (default, `ratio` required) performs the prestige when
   * `(earned + gain) / earned >= ratio`, or at the first whole unit of gain when
   * nothing was earned yet. With `rule: "rate"` performs it once the run's
   * earning rate has dropped (see `rateRulePrestige`).
   */
  | { kind: "autoPrestige"; prestigeCode: string; ratio?: number; rule?: "ratio" | "rate" }
  /**
   * When the prestige fires, the upgrades it resets keep `floor(bought · fraction)`
   * levels. With several active keepLevels for the same prestige the largest
   * fraction wins.
   */
  | { kind: "keepLevels"; prestigeCode: string; fraction: number; upgradeCodes?: string[] }
  /**
   * After a prestige, each listed upgrade that the prestige resets restarts at
   * `max(kept levels, levels)`.
   */
  | { kind: "grantLevels"; prestigeCode: string; upgradeCode: string; levels: number };

export interface Upgrade extends Buyable, Coded, Resettable {
  name: string;

  /** Free text for the host. */
  desc?: string;

  /** Free text for the host. */
  summary?: string;

  effects: Effect[];

  behaviors?: UpgradeBehavior[];

  /**
   * On purchase, every `add` effect on a producer's `resetsTo` also adds the
   * increment to that producer's `amount` (never to `bought`).
   */
  grantOnPurchase?: boolean;
}
