import { z } from "zod";

import { DefaultEntityRegistry } from "../core/di/defaults";
import { EffectRegistry } from "../core/registries/effect";
import { BUILT_IN_GROWTHS, GrowthRegistry } from "../core/registries/growth";
import { type DefinitionIssue, type DefinitionIssueCode, type DefinitionRange, checkTarget, walkState } from "../core/validation";
import type { Effect, GrowthFunction, Target } from "../models/base";
import { ScaleOnSchema, TargetSchema } from "../models/schema";
import { type Decimal, type GenericNumberInput, N } from "../nums";
import { type GameDefinition, MIN_CLICK_COOLDOWN_MS, stateFromDefinition } from "./definition";

export type { DefinitionIssue, DefinitionIssueCode, DefinitionRange } from "../core/validation";

/** Registries a definition is validated against. Default: the built-in growth methods and effect types. */
export interface DefinitionValidationContext {
  growths?: GrowthRegistry;
  effectTypes?: EffectRegistry;
}

type Path = (string | number)[];

// ============================================================================
// PHASE 1 — shape and numbers
// ============================================================================
const INVALID_NUMBER = "invalidNumber";

/** True for a finite number, a string `N()` reads as a finite Decimal, a Decimal, or a well-formed `{ sign, layer, mag }`. */
function isValidNumberInput(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") {
    try {
      const d = N(value);
      return !d.isNan() && Number.isFinite(d.mag);
    } catch {
      return false;
    }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const { sign, layer, mag } = value as { sign?: unknown; layer?: unknown; mag?: unknown };
    return (sign === -1 || sign === 0 || sign === 1) && typeof layer === "number" && Number.isInteger(layer) && layer >= 0 && typeof mag === "number" && Number.isFinite(mag);
  }
  return false;
}

/** A `GenericNumberInput` (see `isValidNumberInput`). Reports `invalidNumber`, also when the field is missing. */
const numberInput = z.custom<GenericNumberInput>(isValidNumberInput, { message: INVALID_NUMBER });
/** A plain finite JS number. */
const plainNumber = z.custom<number>((v) => typeof v === "number" && Number.isFinite(v), { message: INVALID_NUMBER });

const growthFunctionShape = z.object({
  base: numberInput,
  coeff: numberInput,
  offset: numberInput.optional(),
  func: z.string().min(1),
  scaleOn: ScaleOnSchema,
});

const effectShape = z.object({
  stage: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  source: TargetSchema.optional(),
  target: TargetSchema,
  type: z.string().min(1),
  func: growthFunctionShape,
});

const unlockShape = z.object({
  kind: z.enum(["currency", "producer", "upgrade"]),
  code: z.string(),
  field: z.enum(["amount", "earned", "bought"]),
  gt: numberInput,
});

const extraCostShape = z.object({
  currencyCode: z.string(),
  scaling: growthFunctionShape,
  fromBought: plainNumber.optional(),
});

const producerShape = z.object({
  code: z.string(),
  name: z.string(),
  sub: z.string().optional(),
  amount: numberInput.optional(),
  currencyCode: z.string(),
  scaling: growthFunctionShape,
  extraCosts: z.array(extraCostShape).optional(),
  produces: z.array(z.object({ code: z.string(), persec: numberInput, persecEffective: numberInput.optional() })),
  persecDelta: numberInput.optional(),
  resetsOn: z.array(z.string()),
  resetsTo: numberInput.optional(),
  max: numberInput.optional(),
  priority: plainNumber.optional(),
  capacity: z.object({ base: numberInput, factor: numberInput, decayScale: plainNumber, overflowRate: plainNumber.optional() }).optional(),
  dragExempt: z.boolean().optional(),
  unlock: unlockShape.optional(),
});

const currencyShape = z.object({
  code: z.string(),
  name: z.string(),
  amount: numberInput,
  primary: z.boolean().optional(),
  earned: numberInput.optional(),
  drive: z.object({ unspentWeight: plainNumber, earnedWeight: plainNumber }).optional(),
  capacityMult: numberInput.optional(),
  gainMult: numberInput.optional(),
  coolingMult: numberInput.optional(),
  dripMult: numberInput.optional(),
  resetsEarnedOn: z.array(z.string()).optional(),
  effects: z.array(effectShape).optional(),
  persecDelta: numberInput.optional(),
  resetsOn: z.array(z.string()).optional(),
  resetsTo: numberInput.optional(),
});

const behaviorShape = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("autobuyUpgrades"), prestigeCode: z.string().optional(), upgradeCodes: z.array(z.string()).optional() }),
  z.object({ kind: z.literal("prestigeDrip"), prestigeCode: z.string(), ratePerSecond: plainNumber }),
  z.object({ kind: z.literal("autoPrestige"), prestigeCode: z.string(), ratio: plainNumber.optional(), rule: z.enum(["ratio", "rate"]).optional() }),
  z.object({ kind: z.literal("keepLevels"), prestigeCode: z.string(), fraction: plainNumber, upgradeCodes: z.array(z.string()).optional() }),
  z.object({ kind: z.literal("grantLevels"), prestigeCode: z.string(), upgradeCode: z.string(), levels: plainNumber }),
]);

const upgradeShape = z.object({
  code: z.string(),
  name: z.string(),
  desc: z.string().optional(),
  summary: z.string().optional(),
  currencyCode: z.string(),
  scaling: growthFunctionShape,
  extraCosts: z.array(extraCostShape).optional(),
  effects: z.array(effectShape),
  behaviors: z.array(behaviorShape).optional(),
  resetsOn: z.array(z.string()).optional(),
  resetsTo: numberInput.optional(),
  max: numberInput.optional(),
  unlock: unlockShape.optional(),
  grantOnPurchase: z.boolean().optional(),
});

const prestigeShape = z.object({
  code: z.string(),
  currencyCode: z.string(),
  source: TargetSchema,
  target: TargetSchema,
  effects: z.array(effectShape),
  func: growthFunctionShape,
});

const rulesShape = z.object({
  saturation: z
    .object({
      decayExponent: plainNumber.optional(),
      overflowCurrencyCode: z.string().optional(),
      gate: z.object({ currencyCode: z.string(), earnedAtLeast: plainNumber }).optional(),
      push: z.object({ currencyCode: z.string(), exponent: plainNumber }).optional(),
      drag: z.object({ onset: plainNumber, scale: plainNumber, exponent: plainNumber, floor: plainNumber }).optional(),
      cooling: z.object({ halfLifeMs: plainNumber }).optional(),
    })
    .optional(),
});

const definitionShape = z.object({
  meta: z.object({ id: z.string().min(1), name: z.string(), version: plainNumber, description: z.string().optional() }),
  benchmark: z.object({ overflowCurrencyCode: z.string().optional(), trackedProducerCode: z.string().optional() }).optional(),
  rules: rulesShape.optional(),
  producers: z.array(producerShape),
  currencies: z.array(currencyShape),
  prestiges: z.array(prestigeShape),
  upgrades: z.array(upgradeShape),
  clickable: z.object({ currencyCode: z.string().optional(), gain: plainNumber.optional(), cooldownMs: plainNumber.optional() }).optional(),
});

function pathLabel(path: Path): string {
  return path.length === 0 ? "definition" : path.join(".");
}

// ============================================================================
// PHASE 2 — rules
// ============================================================================
const BUILT_IN_GROWTH_IDS: ReadonlySet<string> = new Set(BUILT_IN_GROWTHS.map((def) => def.id));

const POSITIVE: DefinitionRange = { min: 0, minExclusive: true };
const NON_NEGATIVE: DefinitionRange = { min: 0 };
const UNIT_INTERVAL: DefinitionRange = { min: 0, max: 1 };

function describeRange(range: DefinitionRange): string {
  const lo = range.min === undefined ? "" : `${range.minExclusive ? ">" : ">="} ${range.min}`;
  const hi = range.max === undefined ? "" : `${range.maxExclusive ? "<" : "<="} ${range.max}`;
  return lo && hi ? `${lo} and ${hi}` : lo || hi;
}

function inRange(value: Decimal, range: DefinitionRange): boolean {
  if (range.min !== undefined && (range.minExclusive ? !value.gt(range.min) : !value.gte(range.min))) return false;
  if (range.max !== undefined && (range.maxExclusive ? !value.lt(range.max) : !value.lte(range.max))) return false;
  return true;
}

function decimalOf(value: GenericNumberInput | undefined): Decimal | undefined {
  if (value === undefined) return undefined;
  try {
    const d = N(value);
    return d.isNan() ? undefined : d;
  } catch {
    return undefined;
  }
}

function checkRules(def: GameDefinition, ctx: DefinitionValidationContext): DefinitionIssue[] {
  const growths = ctx.growths ?? new GrowthRegistry();
  const effectTypes = ctx.effectTypes ?? new EffectRegistry();
  const registry = new DefaultEntityRegistry();
  const issues: DefinitionIssue[] = [];

  const add = (code: DefinitionIssueCode, path: Path, message: string, range?: DefinitionRange): void => {
    issues.push(range ? { code, path, message, range } : { code, path, message });
  };

  /** Out-of-range finding for an optional numeric field; absent fields pass. */
  const range = (value: GenericNumberInput | undefined, bounds: DefinitionRange, path: Path): void => {
    const d = decimalOf(value);
    if (d && !inRange(d, bounds)) add("outOfRange", path, `${pathLabel(path)} must be ${describeRange(bounds)}`, bounds);
  };

  // Target checks read the state a definition describes.
  const state = stateFromDefinition(def);

  const currencyCodes = new Set(def.currencies.map((c) => c.code));
  const producerCodes = new Set(def.producers.map((p) => p.code));
  const prestigeCodes = new Set(def.prestiges.map((p) => p.code));

  // --- codes -------------------------------------------------------------
  const currencySeen = new Set<string>();
  for (const c of def.currencies) currencySeen.add(c.code);
  def.producers.forEach((producer, i) => {
    if (currencySeen.has(producer.code)) {
      add("duplicateCode", ["producers", i, "code"], `Producer code "${producer.code}" is already used by a currency`);
    }
  });

  const primaries = def.currencies.filter((c) => c.primary).length;
  if (primaries !== 1) {
    add("onePrimary", ["currencies"], `exactly one currency must declare "primary: true" (found ${primaries}): it anchors the balance value model`);
  }

  // --- references --------------------------------------------------------
  const checkPrestigeRefs = (codes: string[] | undefined, path: Path): void => {
    (codes ?? []).forEach((code, k) => {
      if (!prestigeCodes.has(code)) add("unknownPrestige", [...path, "resetsOn", k], `${pathLabel([...path, "resetsOn", k])}: unknown prestige "${code}"`);
    });
  };

  const checkCurrencyRef = (code: string | undefined, path: Path): void => {
    if (code !== undefined && !currencyCodes.has(code)) add("unknownCurrency", path, `${pathLabel(path)}: unknown currency "${code}"`);
  };

  // --- curves ------------------------------------------------------------
  type Role = "cost" | "effect" | "prestige";
  const checkCurve = (func: GrowthFunction, path: Path, role: Role, constantPriceAllowed = false): void => {
    const method = growths.lookup(func.func);
    if (!method) return; // reported as unknownGrowth by the state walker

    const base = decimalOf(func.base);
    const coeff = decimalOf(func.coeff);

    if (BUILT_IN_GROWTH_IDS.has(func.func)) {
      const id = func.func;
      const constantPrice =
        role === "cost" &&
        constantPriceAllowed &&
        id === "linear" &&
        coeff?.eq(0) === true &&
        base?.gt(0) === true &&
        (func.offset === undefined || decimalOf(func.offset)?.eq(0) === true);

      const growsBase = role === "cost" && (id === "exponential" || id === "double_exponential");
      range(func.base, growsBase ? { min: 1, minExclusive: true } : POSITIVE, [...path, "base"]);

      if (!constantPrice) {
        if (role === "cost" && (id === "geometric" || id === "double_exponential")) {
          range(func.coeff, { min: 1, minExclusive: true }, [...path, "coeff"]);
        } else if (role === "effect" && id === "linear") {
          range(func.coeff, NON_NEGATIVE, [...path, "coeff"]);
        } else {
          range(func.coeff, POSITIVE, [...path, "coeff"]);
        }
      }
    }

    if (role === "cost") {
      range(func.offset, NON_NEGATIVE, [...path, "offset"]);
      if (!method.capabilities.hasClosedFormSum || !method.capabilities.hasClosedFormNmax) {
        add(
          "unsupportedCostCurve",
          [...path, "func"],
          `${pathLabel([...path, "func"])}: growth method "${func.func}" has no closed-form sum and maximum, so it cannot price purchases`,
        );
      }
      if (func.scaleOn !== "self") {
        add("unsupportedCostCurve", [...path, "scaleOn"], `${pathLabel([...path, "scaleOn"])}: a cost curve must scale on "self"`);
      }
    }
  };

  const checkTargetRef = (target: Target, path: Path, label: string): void => {
    const problem = checkTarget(state, { registry }, target);
    if (problem?.code === "unresolvablePath") {
      add(problem.code, [...path, "path"], `${label}: path "${target.path}" cannot be resolved on ${target.kind} "${target.code}"`);
    } else if (problem) {
      add(problem.code, [...path, "code"], `${label}: unknown ${target.kind} "${target.code}"`);
    }
  };

  const checkEffects = (effects: Effect[], path: Path): void => {
    effects.forEach((effect, k) => {
      const effectPath = [...path, "effects", k];
      checkCurve(effect.func, [...effectPath, "func"], "effect");
      if (effect.source) checkTargetRef(effect.source, [...effectPath, "source"], pathLabel([...effectPath, "source"]));
    });
  };

  // --- meta, benchmark, clickable ----------------------------------------
  if (def.benchmark) {
    checkCurrencyRef(def.benchmark.overflowCurrencyCode, ["benchmark", "overflowCurrencyCode"]);
    const tracked = def.benchmark.trackedProducerCode;
    if (tracked !== undefined && !producerCodes.has(tracked)) {
      add("unknownProducer", ["benchmark", "trackedProducerCode"], `benchmark.trackedProducerCode: unknown producer "${tracked}"`);
    }
  }

  if (def.clickable) {
    if (def.clickable.currencyCode !== undefined && !currencyCodes.has(def.clickable.currencyCode)) {
      add("unknownCurrency", ["clickable", "currencyCode"], `clickable.currencyCode "${def.clickable.currencyCode}" is not a currency of the definition`);
    }
    range(def.clickable.gain, POSITIVE, ["clickable", "gain"]);
    range(def.clickable.cooldownMs, { min: MIN_CLICK_COOLDOWN_MS }, ["clickable", "cooldownMs"]);
  }

  // --- currencies ----------------------------------------------------------
  def.currencies.forEach((currency, i) => {
    const path: Path = ["currencies", i];
    range(currency.amount, NON_NEGATIVE, [...path, "amount"]);
    range(currency.earned, NON_NEGATIVE, [...path, "earned"]);
    range(currency.resetsTo, NON_NEGATIVE, [...path, "resetsTo"]);
    range(currency.gainMult, POSITIVE, [...path, "gainMult"]);
    range(currency.capacityMult, POSITIVE, [...path, "capacityMult"]);
    range(currency.coolingMult, POSITIVE, [...path, "coolingMult"]);
    range(currency.dripMult, POSITIVE, [...path, "dripMult"]);
    checkEffects(currency.effects ?? [], path);
    range(currency.drive?.unspentWeight, NON_NEGATIVE, [...path, "drive", "unspentWeight"]);
    range(currency.drive?.earnedWeight, NON_NEGATIVE, [...path, "drive", "earnedWeight"]);
    checkPrestigeRefs(currency.resetsOn, path);
  });

  // Extra costs: unknown/duplicate pools and `fromBought` are reported by the state walker below; here only the curve rules.
  const checkExtraCosts = (extras: { scaling: GrowthFunction }[] | undefined, path: Path, constantPriceAllowed = false): void => {
    (extras ?? []).forEach((extra, k) => checkCurve(extra.scaling, [...path, "extraCosts", k, "scaling"], "cost", constantPriceAllowed));
  };

  // --- producers -----------------------------------------------------------
  def.producers.forEach((producer, i) => {
    const path: Path = ["producers", i];
    if (!currencyCodes.has(producer.currencyCode) && !producerCodes.has(producer.currencyCode)) {
      add("unknownCostPool", [...path, "currencyCode"], `${pathLabel([...path, "currencyCode"])}: "${producer.currencyCode}" is neither a currency nor a producer`);
    }
    range(producer.amount, NON_NEGATIVE, [...path, "amount"]);
    range(producer.resetsTo, NON_NEGATIVE, [...path, "resetsTo"]);
    range(producer.max, POSITIVE, [...path, "max"]);
    checkPrestigeRefs(producer.resetsOn, path);
    checkCurve(producer.scaling, [...path, "scaling"], "cost");
    checkExtraCosts(producer.extraCosts, path);

    producer.produces.forEach((produced, j) => {
      const producedPath = [...path, "produces", j];
      range(produced.persec, POSITIVE, [...producedPath, "persec"]);
      if (produced.code === producer.code) {
        add("selfProduction", [...producedPath, "code"], `Producer ${producer.code} cannot produce itself`);
      }
    });

    if (producer.capacity) {
      range(producer.capacity.base, POSITIVE, [...path, "capacity", "base"]);
      range(producer.capacity.factor, POSITIVE, [...path, "capacity", "factor"]);
      range(producer.capacity.decayScale, POSITIVE, [...path, "capacity", "decayScale"]);
      range(producer.capacity.overflowRate, UNIT_INTERVAL, [...path, "capacity", "overflowRate"]);
    }
  });

  // --- upgrades ------------------------------------------------------------
  def.upgrades.forEach((upgrade, i) => {
    const path: Path = ["upgrades", i];
    if (!currencyCodes.has(upgrade.currencyCode) && !producerCodes.has(upgrade.currencyCode)) {
      add("unknownCostPool", [...path, "currencyCode"], `${pathLabel([...path, "currencyCode"])}: "${upgrade.currencyCode}" is neither a currency nor a producer`);
    }
    range(upgrade.max, POSITIVE, [...path, "max"]);
    range(upgrade.resetsTo, NON_NEGATIVE, [...path, "resetsTo"]);
    checkPrestigeRefs(upgrade.resetsOn, path);
    checkCurve(upgrade.scaling, [...path, "scaling"], "cost", upgrade.max !== undefined);
    checkExtraCosts(upgrade.extraCosts, path, upgrade.max !== undefined);
    checkEffects(upgrade.effects, path);

    (upgrade.behaviors ?? []).forEach((behavior, k) => {
      const behaviorPath = [...path, "behaviors", k];
      if (behavior.kind === "prestigeDrip") range(behavior.ratePerSecond, POSITIVE, [...behaviorPath, "ratePerSecond"]);
      if (behavior.kind === "autoPrestige") range(behavior.ratio, POSITIVE, [...behaviorPath, "ratio"]);
      if (behavior.kind === "grantLevels") range(behavior.levels, POSITIVE, [...behaviorPath, "levels"]);
      if (behavior.kind === "keepLevels") range(behavior.fraction, UNIT_INTERVAL, [...behaviorPath, "fraction"]);
    });
  });

  // --- prestiges -----------------------------------------------------------
  def.prestiges.forEach((prestige, i) => {
    const path: Path = ["prestiges", i];
    checkCurrencyRef(prestige.currencyCode, [...path, "currencyCode"]);
    checkCurve(prestige.func, [...path, "func"], "prestige");
    checkEffects(prestige.effects, path);
  });

  // --- saturation ------------------------------------------------------------
  const saturation = def.rules?.saturation;
  if (saturation) {
    const base: Path = ["rules", "saturation"];
    range(saturation.decayExponent, POSITIVE, [...base, "decayExponent"]);
    range(saturation.gate?.earnedAtLeast, NON_NEGATIVE, [...base, "gate", "earnedAtLeast"]);
    range(saturation.drag?.onset, NON_NEGATIVE, [...base, "drag", "onset"]);
    range(saturation.drag?.scale, POSITIVE, [...base, "drag", "scale"]);
    range(saturation.drag?.exponent, POSITIVE, [...base, "drag", "exponent"]);
    range(saturation.drag?.floor, UNIT_INTERVAL, [...base, "drag", "floor"]);
    range(saturation.cooling?.halfLifeMs, POSITIVE, [...base, "cooling", "halfLifeMs"]);
  }

  // --- the state walker shared with validateBootstrap ----------------------
  for (const found of walkState(state, { registry, growths, effectTypes }, { emptyReferencesAreUnknown: true })) {
    if (found.severity === "warning" || found.code === "suspiciousCoeff" || found.code === "lateTransientEffect") continue;
    add(found.code, found.path, found.message, found.range);
  }

  return issues;
}

/** Drops findings repeating an earlier one at the same path with the same code (the first, stricter one wins). */
function dedupe(issues: DefinitionIssue[]): DefinitionIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}|${JSON.stringify(issue.path)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function shapeIssues(error: z.ZodError): DefinitionIssue[] {
  return error.issues.map((issue): DefinitionIssue => {
    const path = issue.path.map((p) => (typeof p === "number" ? p : String(p)));
    if (issue.code === "custom" && issue.message === INVALID_NUMBER) {
      return { code: "invalidNumber", path, message: `${pathLabel(path)} must be a finite number` };
    }
    return { code: "invalidShape", path, message: `${pathLabel(path)}: ${issue.message}` };
  });
}

/**
 * Validates an untyped game definition (typically parsed JSON). Pure; never
 * throws, for any input. An empty list means the definition is valid and can be
 * evaluated.
 *
 * Phase 1 checks shape and numbers at every depth (`invalidShape`,
 * `invalidNumber`). Only when it is clean does phase 2 run: unique codes,
 * references, numeric intervals, growth-method domains (read from the growth
 * registry) and the state-level checks `validateBootstrap` shares.
 *
 * Without `ctx` the built-in growth methods and effect types apply.
 */
export function validateGameDefinition(raw: unknown, ctx: DefinitionValidationContext = {}): DefinitionIssue[] {
  try {
    const shape = definitionShape.safeParse(raw);
    if (!shape.success) return shapeIssues(shape.error);
    return dedupe(checkRules(shape.data as unknown as GameDefinition, ctx));
  } catch {
    // Never read or convert the caught value: it may be a hostile object whose conversion throws.
    return [{ code: "invalidShape", path: [], message: "definition could not be read" }];
  }
}

/**
 * Validates an untyped parsed JSON into a `GameDefinition`: throws, listing
 * every finding of `validateGameDefinition`, when the definition is not valid
 * and evaluable. Returns the input itself (not a copy) when it is. `ctx` is
 * passed on unchanged: a game with its own growth methods registers them there.
 */
export function parseGameDefinition(raw: unknown, ctx: DefinitionValidationContext = {}): GameDefinition {
  const issues = validateGameDefinition(raw, ctx);
  if (issues.length > 0) {
    const lines = issues.map((issue) => (issue.path.length > 0 ? `${issue.message} (${issue.path.join(".")})` : issue.message));
    throw new Error(`Invalid game definition: ${lines.join("; ")}`);
  }
  return raw as GameDefinition;
}
