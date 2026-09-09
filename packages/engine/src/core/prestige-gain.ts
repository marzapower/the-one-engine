/**
 * Prestige-gain math: what stock of a prestige currency drives its passive
 * effects, how bought upgrades scale the delivered gain, and how a raw
 * conversion value becomes the whole-unit amount a prestige actually grants.
 */
import type { Currency, Prestige, PrestigeDrive } from "../models/base";
import { type Decimal, N } from "../nums";
import type { GameState } from "../state";
import type { EngineServices } from "./di/types";
import { computeGrowthFunction } from "./growth";

/** A currency's passive effects are driven entirely by its lifetime earned total. */
export const DEFAULT_PRESTIGE_DRIVE: PrestigeDrive = { unspentWeight: 0, earnedWeight: 1 };

/**
 * The prestige-currency stock driving its passive effects:
 * `amount * unspentWeight + (earned ?? amount) * earnedWeight`. Falls back to
 * `DEFAULT_PRESTIGE_DRIVE` without a declared `drive`.
 */
export function prestigeDrive(currency: Pick<Currency, "amount" | "earned" | "drive">): Decimal {
  const drive = currency.drive ?? DEFAULT_PRESTIGE_DRIVE;
  const unspent = N(currency.amount);
  const earned = N(currency.earned ?? currency.amount);
  return unspent.mul(drive.unspentWeight).add(earned.mul(drive.earnedWeight));
}

/**
 * Folds every bought upgrade's effect targeting the prestige currency's
 * `gainMult` path onto its base value (default 1), using the effect
 * registry's `apply` so custom effect types compose correctly.
 */
export function prestigeGainMultiplier(state: GameState, prestige: Prestige, services: EngineServices): Decimal {
  const currency = state.currencies.find((c) => c.code === prestige.currencyCode);
  let mult = N(currency?.gainMult ?? 1);

  for (const upgrade of state.upgrades) {
    if (N(upgrade.bought).lte(0)) continue;
    for (const effect of upgrade.effects) {
      const target = effect.target;
      if (target.kind !== "currency" || target.code !== prestige.currencyCode || target.path !== "gainMult") continue;
      const effectDef = services.effectTypes.lookup(effect.type);
      if (!effectDef) {
        services.logger.error(`Effect type not found: "${effect.type}". Skipping modifier.`);
        continue;
      }
      const computed = computeGrowthFunction(effect.func, upgrade.bought, services.growths);
      mult = N(effectDef.apply(mult, computed));
    }
  }

  return mult;
}

/**
 * The whole units a prestige delivers for a raw (unfloored) conversion
 * value: nothing below a raw gain of 1, otherwise `floor(raw * gainMult)` —
 * the multiplier scales the delivered amount, never the unlock threshold.
 */
export function deliveredPrestigeGain(raw: Decimal, gainMult: Decimal): Decimal {
  if (raw.lt(1)) return N(0);
  return raw.mul(gainMult).floor();
}
