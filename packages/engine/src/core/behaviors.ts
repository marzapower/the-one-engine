import type { Currency, Upgrade, UpgradeBehavior } from "../models/base";
import { N, NR, type Numerus } from "../nums";
import type { GameState } from "../state";
import type { Engine } from "./engine";

/**
 * Behaviours of the given kind declared by upgrades with `bought >= 1`, in
 * declaration order (upgrade array order, then the upgrade's own `behaviors`
 * array order), each paired with the upgrade that owns it.
 */
export function activeBehaviors<K extends UpgradeBehavior["kind"]>(state: GameState, kind: K): { upgrade: Upgrade; behavior: Extract<UpgradeBehavior, { kind: K }> }[] {
  const result: { upgrade: Upgrade; behavior: Extract<UpgradeBehavior, { kind: K }> }[] = [];
  for (const upgrade of state.upgrades) {
    if (N(upgrade.bought).lt(1)) continue;
    for (const behavior of upgrade.behaviors ?? []) {
      if (behavior.kind === kind) {
        result.push({ upgrade, behavior: behavior as Extract<UpgradeBehavior, { kind: K }> });
      }
    }
  }
  return result;
}

/**
 * Each tick, every active `autobuyUpgrades` behaviour buys one level of every
 * upgrade its `prestigeCode` resets (or, without a `prestigeCode`, every
 * upgrade that resets on any prestige), paying from the upgrade's own cost
 * pool and respecting its `max`. A behaviour naming an unknown prestige is
 * ignored entirely.
 */
export function runUpgradeAutobuyers(engine: Engine, state: GameState): void {
  const { registry } = engine.services;
  for (const { behavior } of activeBehaviors(state, "autobuyUpgrades")) {
    if (behavior.prestigeCode && !state.prestiges.some((p) => p.code === behavior.prestigeCode)) continue;

    const targets = state.upgrades.filter((u) => (behavior.prestigeCode ? (u.resetsOn?.includes(behavior.prestigeCode) ?? false) : (u.resetsOn?.length ?? 0) > 0));

    for (const upgrade of targets) {
      if (upgrade.max && N(upgrade.amount).add(1).gt(N(upgrade.max))) continue;

      const cost = engine.costToBuyNext(upgrade, 1);
      const pool = (registry.getByCode(state, "currency", upgrade.currencyCode) ?? registry.getByCode(state, "producer", upgrade.currencyCode)) as { amount: Numerus } | undefined;
      if (!pool || N(cost).gt(N(pool.amount))) continue;

      pool.amount = NR(N(pool.amount).sub(N(cost)));
      upgrade.bought = NR(N(upgrade.bought).add(1));
      upgrade.amount = NR(N(upgrade.amount).add(1));
    }
  }
}

/**
 * Every second, each active `prestigeDrip` behaviour grants
 * `ratePerSecond * level` of the gain its prestige would deliver right now
 * (`Engine.prestigeGain`, so the gate and `gainMult` already apply) to the
 * prestige currency's amount and lifetime earned. A behaviour naming an
 * unknown prestige, or one that currently delivers nothing, is a no-op.
 */
export function applyPrestigeDrips(engine: Engine, state: GameState, elapsedMs: number): void {
  if (elapsedMs <= 0) return;

  for (const { upgrade, behavior } of activeBehaviors(state, "prestigeDrip")) {
    const prestige = state.prestiges.find((p) => p.code === behavior.prestigeCode);
    if (!prestige) continue;

    const gain = engine.prestigeGain(state, prestige);
    if (gain.lte(0)) continue;

    const level = N(upgrade.bought).toNumber();
    const drip = gain.mul(behavior.ratePerSecond * level * (elapsedMs / 1000));

    const currency = engine.services.registry.getByCode(state, "currency", prestige.currencyCode) as Currency | undefined;
    if (!currency) continue;

    currency.amount = NR(N(currency.amount).add(drip));
    currency.earned = NR(N(currency.earned ?? 0).add(drip));
  }
}

/**
 * Each active `autoPrestige` behaviour performs its prestige once the pending
 * gain would grow the currency's lifetime earned by at least `ratio` — or, if
 * nothing has ever been earned, as soon as a whole unit of gain is available.
 * A behaviour naming an unknown prestige is a no-op.
 */
export function runAutoPrestiges(engine: Engine, state: GameState): void {
  for (const { behavior } of activeBehaviors(state, "autoPrestige")) {
    const prestige = state.prestiges.find((p) => p.code === behavior.prestigeCode);
    if (!prestige) continue;

    const gain = engine.prestigeGain(state, prestige);
    if (gain.lt(1)) continue;

    const currency = engine.services.registry.getByCode(state, "currency", prestige.currencyCode) as Currency | undefined;
    const earned = N(currency?.earned ?? 0);
    if (earned.gt(0) && earned.add(gain).div(earned).lt(behavior.ratio)) continue;

    engine.performPrestige(state, prestige);
  }
}

/**
 * The largest `keepLevels` fraction active for `prestigeCode` (several
 * behaviours may target the same prestige; the strongest one wins), or 0
 * when none applies.
 */
export function keptLevelsFraction(state: GameState, prestigeCode: string): number {
  let max = 0;
  for (const { behavior } of activeBehaviors(state, "keepLevels")) {
    if (behavior.prestigeCode === prestigeCode) max = Math.max(max, behavior.fraction);
  }
  return max;
}
