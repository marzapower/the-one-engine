import type { Engine } from "../core/engine";
import { producerPurchaseBlock, upgradePurchaseBlock } from "../core/purchase";
import type { Currency, Producer, Upgrade } from "../models/base";
import type { Numerus } from "../nums";
import type { GameState } from "../state";

/**
 * The currency the game declares as its own point (`Currency.primary`) —
 * the anchor of the whole balance value model. Data-driven: no code is ever
 * assumed. Undefined when the state declares none (dead-end for the value
 * model: chains never resolve, horizon values are 0).
 */
export function primaryCurrencyOf(state: GameState): Currency | undefined {
  return state.currencies.find((c) => c.primary);
}

/** Cost of the next single unit of a producer. */
export function nextUnitCost(engine: Engine, producer: Producer): Numerus {
  return engine.costToBuyNext(producer, 1);
}

/** Cost of the next level of an upgrade. */
export function upgradeCost(engine: Engine, upgrade: Upgrade): Numerus {
  return engine.costToBuyNext(upgrade, 1);
}

/** Cost-pool lookup: owned by the core (`core/purchase.ts`), re-exported so balance consumers keep their import path. */
export { findCostPool } from "../core/purchase";

/**
 * A sample point is "dead" when NO action is available: no producer's next
 * single unit is affordable, no upgrade is affordable (respecting `max`),
 * and no prestige would yield a positive gain. See types.ts DeadTimeWindow.
 */
export function anyActionAvailable(engine: Engine, state: GameState): boolean {
  // Purchase rules (max, lock, cost pool, affordability) live in the core: one source of truth.
  if (state.producers.some((producer) => producerPurchaseBlock(engine, state, producer, 1) === null)) return true;
  if (state.upgrades.some((upgrade) => upgradePurchaseBlock(engine, state, upgrade) === null)) return true;

  for (const prestige of state.prestiges) {
    if (engine.prestigeGain(state, prestige).gt(0)) {
      return true;
    }
  }

  return false;
}
