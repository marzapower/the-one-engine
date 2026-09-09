import type { Engine } from "../core/engine";
import type { Effect, Upgrade } from "../models/base";
import { type Decimal, N, NR } from "../nums";
import type { GameState } from "../state";
import { primaryCurrencyOf } from "./queries";

/**
 * Horizon-value estimation for the greedy balance bot (see `greedy-bot.ts`).
 *
 * All functions here are pure: they read the current `state` but never mutate
 * it, and never call `toNumber()` on quantities that can grow unbounded (only
 * on small, bounded integers like chain `depth`, which is at most the number
 * of producers in the state).
 */

/**
 * Follows the `produces` chain of a producer up to the primary currency,
 * using the CURRENT effective per-unit rates: with the modifier pipeline,
 * `produces[i].persec` in state is the immutable base — the engine publishes
 * the post-modifier rate in the derived `persecEffective` channel every tick
 * (fallback to `persec` for states that never ticked, e.g. test fixtures).
 *
 * Example: a producer chain `p2 → p1 → primary` resolves at depth 2, with
 * `rateProduct = p(p2→p1) · p(p1→primary)`. A producer whose chain never
 * reaches the primary currency resolves to null.
 *
 * Guards against cycles/dangling links (returns null) and bounds the walk to
 * `state.producers.length + 1` steps.
 */
export function resolveChainToPrimary(state: GameState, producerCode: string): { depth: number; rateProduct: Decimal } | null {
  const primary = primaryCurrencyOf(state);
  if (!primary) return null; // the state declares no primary currency — nothing to measure value in

  const producers = state.producers;
  const maxSteps = producers.length + 1;

  let currentCode = producerCode;
  let rateProduct = N(1);
  let depth = 0;
  const visited = new Set<string>();

  while (depth < maxSteps) {
    if (visited.has(currentCode)) return null; // cycle guard
    visited.add(currentCode);

    const producer = producers.find((p) => p.code === currentCode);
    if (!producer) return null; // dangling link (e.g. a currency with no producer, other than the primary)

    const target = producer.produces[0];
    if (!target) return null;

    rateProduct = rateProduct.mul(N(target.persecEffective ?? target.persec));
    depth += 1;

    if (target.code === primary.code) {
      return { depth, rateProduct };
    }

    currentCode = target.code;
  }

  return null;
}

/**
 * Value (in the primary currency) produced by ONE unit of `producerCode`
 * over a horizon of `horizonMs`, given the current chain to the primary.
 *
 * Derivation: a unit of a depth-k producer feeds depth k-1 continuously,
 * which feeds depth k-2, etc., down to the primary currency. Modeling each
 * depth's output as an instantaneous rate integrated over time, the k-fold
 * iterated integral of a constant rate over [0, H] is `H^k / k!` (this is
 * the same combinatorial factor that appears in the Poisson/Erlang family
 * for k-stage cascades). So: V = rateProduct × H^depth / depth!, where
 * H = horizonMs / 1000 (seconds) and rateProduct is the product of the
 * per-unit persec rates along the chain.
 *
 * Producers whose chain never reaches the primary currency have no value
 * under this model → returns N(0).
 */
export function horizonValueOfProducerUnit(engine: Engine, state: GameState, producerCode: string, horizonMs: number): Decimal {
  const chain = resolveChainToPrimary(state, producerCode);
  if (!chain) return N(0);

  const H = N(horizonMs).div(1000);
  return chain.rateProduct.mul(H.pow(chain.depth)).div(factorial(chain.depth));
}

function factorial(n: number): Decimal {
  let result = N(1);
  for (let i = 2; i <= n; i++) {
    result = result.mul(i);
  }
  return result;
}

/**
 * True when `effect` touches the production of the primary currency,
 * directly (currency = primary, path `persecDelta`) or indirectly (a
 * producer whose chain resolves to the primary, path `produces.*.persec`).
 * Effects on anything else (a currency the model doesn't track, or a
 * producer whose chain doesn't reach the primary) don't contribute value
 * under this model.
 */
function effectImpactsPrimaryChain(state: GameState, effect: Effect, primaryCode: string): boolean {
  const { target } = effect;

  if (target.kind === "currency") {
    return target.code === primaryCode && target.path === "persecDelta";
  }

  if (target.kind === "producer" && target.path === "produces.*.persec") {
    return resolveChainToPrimary(state, target.code) !== null;
  }

  return false;
}

/**
 * Marginal value (in the primary currency, over `horizonMs`) of buying the
 * NEXT unit of `upgrade` — i.e. going from `upgrade.bought` to
 * `upgrade.bought + 1`.
 *
 * For each effect that impacts the primary chain (see `effectImpactsPrimaryChain`):
 * - type "mult": the effect multiplies its target by `engine.growthValue(func, bought)`
 *   each tick. The marginal factor from buying one more is
 *   `f = engine.growthValue(func, bought+1) / engine.growthValue(func, bought)`.
 *   We approximate the resulting bump to primary production using the CURRENT
 *   primary persec (not the true post-chain-compounded value, which would
 *   require re-deriving the whole chain — an acceptable approximation for a
 *   greedy horizon estimate): value ≈ (f − 1) × primaryPersecCurrent × H.
 *   Guard: if `engine.growthValue(func, bought) <= 0` the ratio is
 *   undefined/degenerate — the effect is skipped (contributes 0).
 * - type "add": only modeled when it targets the primary currency's
 *   `persecDelta` directly (an "add" on a producer's `produces.*.persec`
 *   would need re-deriving the chain like above, times H per the chain-value
 *   model — skipped, contributes 0). Value = the raw increase in
 *   `persecDelta`, `engine.growthValue(func, bought+1) - engine.growthValue(func, bought)`,
 *   sustained over the horizon: value = Δ × H.
 * - any other effect type (a custom effect type from the registry): the
 *   value model has no way to price it generically, so it contributes 0.
 *
 * Effects on other currencies contribute 0.
 */
export function horizonValueOfUpgrade(engine: Engine, state: GameState, upgrade: Upgrade, horizonMs: number): Decimal {
  const H = N(horizonMs).div(1000);
  const primaryCurrency = primaryCurrencyOf(state);
  if (!primaryCurrency) return N(0);
  const primaryCode = primaryCurrency.code;
  const primaryPersecCurrent = N(primaryCurrency.persecDelta ?? 0);
  const bought = N(upgrade.bought);
  const boughtNext = bought.add(1);

  let total = N(0);

  for (const effect of upgrade.effects) {
    if (!effectImpactsPrimaryChain(state, effect, primaryCode)) continue;

    if (effect.type === "mult") {
      const denom = engine.growthValue(effect.func, NR(bought));
      if (denom.lte(0)) continue; // degenerate growth function — skip

      const numer = engine.growthValue(effect.func, NR(boughtNext));
      const f = numer.div(denom);
      total = total.add(f.sub(1).mul(primaryPersecCurrent).mul(H));
    } else if (effect.type === "add") {
      if (effect.target.kind === "currency" && effect.target.code === primaryCode && effect.target.path === "persecDelta") {
        const before = engine.growthValue(effect.func, NR(bought));
        const after = engine.growthValue(effect.func, NR(boughtNext));
        total = total.add(after.sub(before).mul(H));
      }
    }
  }

  return total;
}
