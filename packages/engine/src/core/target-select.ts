import type { Target } from "../models/base";
import { N } from "../nums";
import type { GameState } from "../state";

/**
 * The entity code a target points at right now. Without `select` it is
 * `target.code`; with `select.highestOwnedOf` it is the LAST listed producer
 * with `amount > 0`, or null when none is owned.
 */
export function resolveTargetCode(state: GameState, target: Target): string | null {
  const list = target.select?.highestOwnedOf;
  if (!list) return target.code;
  for (let i = list.length - 1; i >= 0; i--) {
    const producer = state.producers.find((p) => p.code === list[i]);
    if (producer && N(producer.amount).gt(0)) return list[i]!;
  }
  return null;
}
