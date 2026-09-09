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
}

/**
 * Validates an untyped parsed JSON into a `GameDefinition`. Structural
 * checks only (presence + referential sanity), not a full schema: the
 * engine's own validation (`validation.ts`) covers state-level invariants
 * once the definition is loaded.
 */
export function parseGameDefinition(raw: unknown): GameDefinition {
  const fail = (msg: string): never => {
    throw new Error(`Invalid game definition: ${msg}`);
  };

  if (typeof raw !== "object" || raw === null) fail("not an object");
  const def = raw as GameDefinition;

  if (!def.meta?.id || typeof def.meta.id !== "string") fail("meta.id missing");
  if (typeof def.meta.version !== "number") fail(`meta.version missing (${def.meta.id})`);

  for (const key of ["producers", "currencies", "prestiges", "upgrades"] as const) {
    if (!Array.isArray(def[key])) fail(`${key} is not an array (${def.meta.id})`);
  }

  const primaries = def.currencies.filter((c) => c.primary);
  if (primaries.length !== 1) {
    fail(`exactly one currency must declare "primary: true" (found ${primaries.length}) — it anchors the balance value model (${def.meta.id})`);
  }
  for (const producer of def.producers) {
    if (!producer.code) fail(`producer without code (${def.meta.id})`);
    if (producer.currencyCode === undefined) fail(`producer "${producer.code}" missing currencyCode — definitions carry bootstrap defaults explicitly (${def.meta.id})`);
    if (producer.resetsOn === undefined) fail(`producer "${producer.code}" missing resetsOn (${def.meta.id})`);
  }

  return def;
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
