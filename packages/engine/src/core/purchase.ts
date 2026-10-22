import type { Effect, Producer, Upgrade } from "../models/base";
import type { Unlock } from "../models/base";
import { N, NR, type Numerus } from "../nums";
import type { GameState } from "../state";
import type { Engine } from "./engine";
import { computeGrowthFunction } from "./growth";

export type { Unlock } from "../models/base";

/** Why a purchase cannot happen right now. `null` means it can. */
export type PurchaseBlock = "unknown" | "maxed" | "locked" | "noPool" | "unaffordable";

/**
 * Resolves the pool an entity's cost is paid FROM: a currency, or a
 * producer's unit stock (`amount`) — upgrades and producers may cost producer units.
 */
export function findCostPool(state: GameState, code: string): { amount: Numerus } | undefined {
  return state.currencies.find((c) => c.code === code) ?? state.producers.find((p) => p.code === code);
}

/** True when the entity has no `unlock`, or the referenced `field` is strictly above `gt`. A missing referenced entity locks. */
export function isUnlocked(state: GameState, entity: { unlock?: Unlock }): boolean {
  const unlock = entity.unlock;
  if (!unlock) return true;
  const list: { code: string; amount: Numerus; earned?: Numerus; bought?: Numerus }[] =
    unlock.kind === "currency" ? state.currencies : unlock.kind === "producer" ? state.producers : state.upgrades;
  const found = list.find((e) => e.code === unlock.code);
  if (!found) return false;
  const value = unlock.field === "earned" ? (found.earned ?? found.amount) : unlock.field === "bought" ? (found.bought ?? 0) : found.amount;
  return N(value).gt(N(unlock.gt));
}

/** Why the next level of `upgrade` cannot be bought, in order: unknown, maxed, locked, noPool, unaffordable. */
export function upgradePurchaseBlock(engine: Engine, state: GameState, upgrade: Upgrade): PurchaseBlock | null {
  if (!state.upgrades.some((u) => u.code === upgrade.code)) return "unknown";
  if (upgrade.max && N(upgrade.amount).add(1).gt(N(upgrade.max))) return "maxed";
  if (!isUnlocked(state, upgrade)) return "locked";
  const pool = findCostPool(state, upgrade.currencyCode);
  if (!pool) return "noPool";
  if (N(engine.costToBuyNext(upgrade, 1)).gt(N(pool.amount))) return "unaffordable";
  return null;
}

/** Buys one level of the upgrade. False when any block applies. */
export function buyUpgrade(engine: Engine, state: GameState, code: string): boolean {
  const upgrade = state.upgrades.find((u) => u.code === code);
  if (!upgrade || upgradePurchaseBlock(engine, state, upgrade) !== null) return false;

  const pool = findCostPool(state, upgrade.currencyCode)!;
  const cost = engine.costToBuyNext(upgrade, 1);
  const oldBought = N(upgrade.bought);

  pool.amount = NR(N(pool.amount).sub(N(cost)));
  upgrade.bought = NR(oldBought.add(1));
  upgrade.amount = NR(N(upgrade.amount).add(1));

  if (upgrade.grantOnPurchase) grantOnPurchase(engine, state, upgrade, oldBought);
  return true;
}

/**
 * For every `add` effect on a producer's `resetsTo`, adds the increment of the
 * new level (`v(new) − v(old)`, `v(0)` counting as 0) to the producer's
 * `amount`. Never touches `bought`: the producer's price does not change.
 */
function grantOnPurchase(engine: Engine, state: GameState, upgrade: Upgrade, oldBought: ReturnType<typeof N>): void {
  const newBought = N(upgrade.bought);
  for (const effect of upgrade.effects as Effect[]) {
    if (effect.type !== "add" || effect.target.kind !== "producer" || effect.target.path !== "resetsTo") continue;
    const newValue = computeGrowthFunction(effect.func, newBought, engine.growths);
    const oldValue = oldBought.gt(0) ? computeGrowthFunction(effect.func, oldBought, engine.growths) : N(0);
    const delta = newValue.sub(oldValue);
    if (!delta.isFinite() || delta.lte(0)) continue;
    const resolved = engine.services.registry.getAccessor(effect.target).resolve(state);
    if (!resolved) continue;
    for (const obj of resolved.objects) {
      const producer = obj as Producer;
      producer.amount = NR(N(producer.amount).add(delta));
    }
  }
}

/** Why `amount` units of `producer` cannot be bought. Same codes as `upgradePurchaseBlock`. */
export function producerPurchaseBlock(engine: Engine, state: GameState, producer: Producer, amount: number): PurchaseBlock | null {
  if (!Number.isFinite(amount) || amount <= 0 || !state.producers.some((p) => p.code === producer.code)) return "unknown";
  // Against `bought`, not `amount`: a producer fed by a higher tier grows on its own, and `max` caps purchases.
  if (producer.max && N(producer.bought).add(amount).gt(N(producer.max))) return "maxed";
  if (!isUnlocked(state, producer)) return "locked";
  const pool = findCostPool(state, producer.currencyCode);
  if (!pool) return "noPool";
  if (N(engine.costToBuyNext(producer, amount)).gt(N(pool.amount))) return "unaffordable";
  return null;
}

/** Buys `amount` units of the producer in one go. False when any block applies. */
export function buyProducer(engine: Engine, state: GameState, code: string, amount: number): boolean {
  const producer = state.producers.find((p) => p.code === code);
  if (!producer || producerPurchaseBlock(engine, state, producer, amount) !== null) return false;

  const pool = findCostPool(state, producer.currencyCode)!;
  const cost = engine.costToBuyNext(producer, amount);
  pool.amount = NR(N(pool.amount).sub(N(cost)));
  producer.bought = NR(N(producer.bought).add(amount));
  producer.amount = NR(N(producer.amount).add(amount));
  return true;
}
