import type { Currency, Prestige, Producer, Upgrade } from "../models/base";
import { NR } from "../nums";
import type { GameRules } from "../rules";
import { createInitialState } from "../state";
import type { GameState } from "../state";

/**
 * Game definition — the JSON-serializable description of a whole game the
 * engine can run: content (producers/currencies/prestiges/upgrades, with
 * every bootstrap default made explicit), the optional data-driven rules
 * (`GameRules`) the game runs under, and the benchmark hints the balance
 * tooling needs to evaluate it.
 *
 * Purpose: decouple "a version of the game" from the codebase. Two
 * definition files can be benchmarked against the same engine build, and the
 * same definition file can be benchmarked against two engine builds.
 *
 * This module is intentionally pure (no filesystem, no content import): it
 * can later back a browser-side "load game from JSON" path unchanged. File
 * I/O and the content → definition export live with the host.
 */

/** Producer entry: the fully-registered shape (currencyCode/resetsOn explicit), minus runtime stock. */
export type DefinitionProducer = Omit<Producer, "amount" | "bought"> & {
  /** Starting stock (post-reset head-start base is `resetsTo`, not this). Default 0. */
  amount?: Producer["amount"];
};

/** Upgrade entry: the fully-registered shape (resetsOn explicit), minus runtime level. */
export type DefinitionUpgrade = Omit<Upgrade, "amount" | "bought">;

/**
 * Optional telemetry hints for the report series. The value-model anchor is
 * NOT here: the game itself declares it via `Currency.primary` (the balance
 * tooling derives it with `primaryCurrencyOf(state)`), so a definition
 * carries no tooling-facing duplication of its own data.
 */
export interface BenchmarkHints {
  /** Saturation overflow currency, sampled as log10Overflow in the report series. */
  overflowCurrencyCode?: string;
  /** Producer whose stock is sampled as log10TrackedProducer in the report series. */
  trackedProducerCode?: string;
}

export interface GameDefinitionMeta {
  /** Stable identifier; also names the benchmark report (bench-<id>.json). */
  id: string;
  name: string;
  /** Bump when the definition changes meaningfully — reports quote it. */
  version: number;
  description?: string;
}

export interface GameDefinition {
  meta: GameDefinitionMeta;
  benchmark?: BenchmarkHints;
  /** Optional data-driven mechanics this definition runs under. Absent = plain producers/upgrades/prestiges. */
  rules?: GameRules;
  producers: DefinitionProducer[];
  currencies: Currency[];
  prestiges: Prestige[];
  upgrades: DefinitionUpgrade[];
  /** Always-present manual action (a "tap" that gives currency). Absent = defaults (see `resolveClickable`). */
  clickable?: Clickable;
}

/** A manual click/tap: raw fields as authored, every one optional. See `resolveClickable` for the resolved form. */
export interface Clickable {
  /** Currency the tap gives. Defaults to the definition's primary currency. */
  currencyCode?: string;
  /** Amount added to the currency per tap. Default 1. */
  gain?: number;
  /** Minimum time between taps, in ms. Default 1000. Floor: `MIN_CLICK_COOLDOWN_MS`. */
  cooldownMs?: number;
}

/** `Clickable` with every default resolved — what `runBalanceSim` actually consumes. */
export interface ResolvedClickable {
  currencyCode: string;
  gain: number;
  cooldownMs: number;
}

/** Defaults mirroring The One Incremental's tap: +1 `one`, 1000 ms cooldown. */
export const DEFAULT_CLICKABLE: { gain: number; cooldownMs: number } = { gain: 1, cooldownMs: 1000 };

/** Floor enforced on `Clickable.cooldownMs` — anything faster stops being a "manual" action. */
export const MIN_CLICK_COOLDOWN_MS = 100;

/**
 * Resolves a definition's clickable to its always-usable form: defaults
 * filled in, currency verified. `undefined` when the definition declares no
 * primary currency, or `clickable.currencyCode` names a currency the
 * definition does not carry — callers (the harness, via
 * `RunBalanceSimOptions.clickable`) then simply never tap.
 */
export function resolveClickable(def: GameDefinition): ResolvedClickable | undefined {
  const primary = def.currencies.find((c) => c.primary);
  if (!primary) return undefined;

  const currencyCode = def.clickable?.currencyCode ?? primary.code;
  if (!def.currencies.some((c) => c.code === currencyCode)) return undefined;

  return {
    currencyCode,
    gain: def.clickable?.gain ?? DEFAULT_CLICKABLE.gain,
    cooldownMs: def.clickable?.cooldownMs ?? DEFAULT_CLICKABLE.cooldownMs,
  };
}

/**
 * Builds the simulation-ready `GameState` a definition describes, with every
 * default already explicit in the definition (no game-specific mapping
 * here). Returns a deep clone: callers can freely mutate it.
 */
export function stateFromDefinition(def: GameDefinition): GameState {
  const state: GameState = {
    ...createInitialState(),
    producers: def.producers.map((p) => ({ ...p, amount: p.amount ?? NR(0), bought: NR(0) })),
    currencies: def.currencies.map((c) => ({ ...c })),
    prestiges: def.prestiges.map((p) => ({ ...p })),
    upgrades: def.upgrades.map((u) => ({ ...u, amount: NR(0), bought: NR(0) })),
    rules: def.rules,
  };

  return structuredClone(state);
}
