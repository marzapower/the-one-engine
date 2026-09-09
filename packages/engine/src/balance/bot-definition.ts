import { N } from "../nums";
import type { GameState } from "../state";
import { GREEDY_DEFAULTS, GreedyBot } from "./greedy-bot";
import type { GreedyBotOptions, ResolvedGreedyBotOptions } from "./greedy-bot";
import type { BotContext, BotIntent, BotPolicy } from "./types";

/**
 * Bot definition — the JSON-serializable description of a player profile
 * for the balance benchmark, the counterpart of the game definition
 * (definition.ts). A definition names a generic policy, sets its knobs, and
 * may layer PHASES: knob overrides that activate when generic conditions on
 * the run hold (elapsed time, currency thresholds by code). Codes referenced
 * in conditions belong to whatever game the bot is paired with — the tooling
 * itself assumes nothing about any specific game.
 *
 * Canonical bot/game definition files live wherever the host project keeps
 * its balance content; a benchmark runs every game definition × every bot
 * definition it finds.
 */

/**
 * A phase activation condition. All present fields must hold (AND). An
 * empty condition always holds (an unconditional override layer).
 */
export interface BotPhaseCondition {
  /** Run time (sim ms) at or past which the phase activates. */
  minElapsedMs?: number;
  /** Currency thresholds, all required. `field` defaults to "amount"; `earned` reads lifetime earned (fallback amount). */
  currencies?: { code: string; field?: "amount" | "earned"; atLeast: number }[];
}

export interface BotPhase {
  when: BotPhaseCondition;
  options: GreedyBotOptions;
}

export interface BotDefinition {
  meta: {
    id: string;
    name: string;
    version: number;
    description?: string;
  };
  /** The generic policy implementing the profile. Extensible: new policies register in `botFromDefinition`. */
  policy: "greedy";
  /** Base knobs (defaults of the policy when omitted). */
  options?: GreedyBotOptions;
  /**
   * Phase layers, evaluated in order at every decision point: base options
   * first, then every phase whose condition currently holds, later phases
   * overriding earlier ones. Conditions are re-evaluated each time, so a
   * phase can also deactivate (e.g. an `amount` threshold after a reset).
   */
  phases?: BotPhase[];
}

/** Structural validation of an untyped parsed JSON into a `BotDefinition`. */
export function parseBotDefinition(raw: unknown): BotDefinition {
  const fail = (msg: string): never => {
    throw new Error(`Invalid bot definition: ${msg}`);
  };

  if (typeof raw !== "object" || raw === null) fail("not an object");
  const def = raw as BotDefinition;

  if (!def.meta?.id || typeof def.meta.id !== "string") fail("meta.id missing");
  if (typeof def.meta.version !== "number") fail(`meta.version missing (${def.meta.id})`);
  if (def.policy !== "greedy") fail(`unknown policy "${String(def.policy)}" (${def.meta.id})`);

  for (const phase of def.phases ?? []) {
    if (typeof phase.when !== "object" || phase.when === null) fail(`phase without "when" condition (${def.meta.id})`);
    if (typeof phase.options !== "object" || phase.options === null) fail(`phase without "options" (${def.meta.id})`);
    for (const threshold of phase.when.currencies ?? []) {
      if (!threshold.code || threshold.atLeast === undefined) fail(`currency condition needs code + atLeast (${def.meta.id})`);
    }
  }

  return def;
}

/** True when every field of the condition holds for the current run state. */
export function phaseConditionHolds(condition: BotPhaseCondition, state: GameState, tSimMs: number): boolean {
  if (condition.minElapsedMs !== undefined && tSimMs < condition.minElapsedMs) return false;

  for (const threshold of condition.currencies ?? []) {
    const currency = state.currencies.find((c) => c.code === threshold.code);
    if (!currency) return false;
    const value = threshold.field === "earned" ? (currency.earned ?? currency.amount) : currency.amount;
    if (N(value).lt(threshold.atLeast)) return false;
  }

  return true;
}

/**
 * The full knob set the definition prescribes for this instant: policy
 * defaults ← base options ← every currently-holding phase, in order.
 */
export function resolveBotOptions(def: BotDefinition, state: GameState, tSimMs: number): ResolvedGreedyBotOptions {
  const resolved: ResolvedGreedyBotOptions = { ...GREEDY_DEFAULTS, ...def.options };

  for (const phase of def.phases ?? []) {
    if (phaseConditionHolds(phase.when, state, tSimMs)) {
      Object.assign(resolved, phase.options);
    }
  }

  return resolved;
}

/**
 * BotPolicy adapter around a definition: re-resolves the knob set at every
 * decision point and pushes it into the underlying policy via `setOptions`
 * (which preserves the policy's internal run state — a phase switch is a
 * change of mind, not a new player).
 */
class DefinedBot implements BotPolicy {
  readonly id: string;
  private readonly inner: GreedyBot;

  constructor(private readonly def: BotDefinition) {
    this.id = def.meta.id;
    this.inner = new GreedyBot({ ...GREEDY_DEFAULTS, ...def.options });
  }

  decide(ctx: BotContext): BotIntent[] {
    if (this.def.phases?.length) {
      this.inner.setOptions(resolveBotOptions(this.def, ctx.state, ctx.tSimMs));
    }
    return this.inner.decide(ctx);
  }
}

/** Instantiates the policy a definition names. The single registry point for future policies. */
export function botFromDefinition(def: BotDefinition): BotPolicy {
  switch (def.policy) {
    case "greedy":
      return new DefinedBot(def);
  }
}
