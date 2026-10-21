import type { Effect, GrowthFunction, Target } from "../models/base";
import { type Decimal, type GenericNumberInput, N } from "../nums";
import type { BootstrapReport, GameState } from "../state";
import type { EngineServices } from "./di/types";

export interface ValidationResult {
  errors: string[];
  warnings: string[];
  report: BootstrapReport;
}

/** Machine-readable kind of a validation issue; shared by bootstrap validation and definition validation. */
export type DefinitionIssueCode =
  | "invalidShape"
  | "invalidNumber"
  | "outOfRange"
  | "duplicateCode"
  | "onePrimary"
  | "unknownCurrency"
  | "unknownProducer"
  | "unknownUpgrade"
  | "unknownPrestige"
  | "unknownGrowable"
  | "unknownCostPool"
  | "selfProduction"
  | "unresolvablePath"
  | "unknownGrowth"
  | "unknownEffectType"
  | "unsupportedCostCurve";

/** The interval a numeric field must lie in; bounds are inclusive unless flagged exclusive. */
export interface DefinitionRange {
  min?: number;
  minExclusive?: boolean;
  max?: number;
  maxExclusive?: boolean;
}

export interface DefinitionIssue {
  code: DefinitionIssueCode;
  /** Path from the root of the validated value. */
  path: (string | number)[];
  /** English, for logs and tests. */
  message: string;
  /** Present for `outOfRange`: what the field accepts. */
  range?: DefinitionRange;
}

/** One finding of the shared state walker. Warnings use `code: "suspiciousCoeff"` and never fail validation. */
export interface WalkIssue {
  severity: "error" | "warning";
  code: DefinitionIssueCode | "suspiciousCoeff";
  path: (string | number)[];
  message: string;
  range?: DefinitionRange;
}

/** Built-in growth methods whose curve degenerates to a straight line when coeff = 1. */
const UNIT_COEFF_WARNING_METHODS = new Set(["geometric", "exponential", "double_exponential"]);

function toNumber(val: GenericNumberInput): number {
  try {
    return N(val).toNumber();
  } catch {
    return NaN;
  }
}

/** `N(val)` as a Decimal, or undefined when the input is not a number or is NaN. Comparisons stay exact for huge values. */
function toDecimal(val: GenericNumberInput): Decimal | undefined {
  try {
    const d = N(val);
    return d.isNan() ? undefined : d;
  } catch {
    return undefined;
  }
}

const TARGET_CODE_ISSUE = {
  producer: "unknownProducer",
  currency: "unknownCurrency",
  upgrade: "unknownUpgrade",
} as const;

/**
 * Checks that a target names an existing entity whose path can be resolved.
 * Returns the finding (without context text), or undefined when the target is sound.
 */
export function checkTarget(
  state: GameState,
  services: Pick<EngineServices, "registry">,
  target: Target,
): { code: "unknownProducer" | "unknownCurrency" | "unknownUpgrade" | "unresolvablePath"; field: "code" | "path" } | undefined {
  const { registry } = services;
  if (!registry.getByCode(state, target.kind, target.code)) {
    return { code: TARGET_CODE_ISSUE[target.kind] ?? "unknownCurrency", field: "code" };
  }
  if (!registry.getAccessor(target).resolve(state)) {
    return { code: "unresolvablePath", field: "path" };
  }
  return undefined;
}

/**
 * Walks a state and reports every structural problem as a structured issue:
 * - unique codes within each entity group;
 * - every target reference (produces, effects, prestige source/target) resolves;
 * - every growth function names a registered method and stays inside its domain;
 * - every effect names a registered effect type;
 * - behavior and saturation-rule references name existing prestiges/currencies;
 * - producer capacity parameters stay in range.
 *
 * Paths follow the state layout (`["producers", 0, "scaling", "base"]`), which a
 * game definition shares. Pure: no logging, no timing. Both `validateBootstrap`
 * and the definition validator are built on it.
 */
export function walkState(
  state: GameState,
  services: Pick<EngineServices, "registry" | "growths" | "effectTypes">,
  options: { emptyReferencesAreUnknown?: boolean } = {},
): WalkIssue[] {
  // Optional references: bootstrap skips an empty string (historic behavior); a definition treats it as a dangling reference.
  const isSet = (code: string | undefined): code is string => (options.emptyReferencesAreUnknown ? code !== undefined : !!code);
  const { registry, growths, effectTypes } = services;
  const issues: WalkIssue[] = [];
  const error = (code: WalkIssue["code"], path: (string | number)[], message: string, range?: DefinitionRange): void => {
    issues.push(range ? { severity: "error", code, path, message, range } : { severity: "error", code, path, message });
  };

  const prestigeCodes = new Set<string>();
  const currencyCodes = new Set<string>();

  const checkDuplicates = (group: "producers" | "currencies" | "upgrades" | "prestiges", label: string, seen: Set<string>): void => {
    state[group].forEach((entity, index) => {
      if (seen.has(entity.code)) {
        error("duplicateCode", [group, index, "code"], `Duplicate ${label} code: ${entity.code}`);
      }
      seen.add(entity.code);
    });
  };
  checkDuplicates("producers", "producer", new Set<string>());
  checkDuplicates("currencies", "currency", currencyCodes);
  checkDuplicates("upgrades", "upgrade", new Set<string>());
  checkDuplicates("prestiges", "prestige", prestigeCodes);

  const validateGrowthFunction = (func: GrowthFunction, context: string, path: (string | number)[]): void => {
    const def = growths.lookup(func.func);
    if (!def) {
      error("unknownGrowth", [...path, "func"], `${context}: unknown growth method "${func.func}"`);
      return;
    }

    const base = toDecimal(func.base);
    const coeff = toDecimal(func.coeff);
    const domain = def.capabilities.domain;

    const checkBound = (name: "base" | "coeff", value: Decimal | undefined, bounds: { min?: number; max?: number } | undefined): void => {
      if (!bounds) return;
      if (bounds.min !== undefined && (value === undefined || value.lt(bounds.min))) {
        error("outOfRange", [...path, name], `${context}: ${name} must be >= ${bounds.min}`, { min: bounds.min });
      }
      if (bounds.max !== undefined && (value === undefined || value.gt(bounds.max))) {
        error("outOfRange", [...path, name], `${context}: ${name} must be <= ${bounds.max}`, { max: bounds.max });
      }
    };
    checkBound("base", base, domain?.base);
    checkBound("coeff", coeff, domain?.coeff);

    const coeffNum = toNumber(func.coeff);
    if (UNIT_COEFF_WARNING_METHODS.has(func.func) && !isNaN(coeffNum) && Math.abs(coeffNum - 1) < 1e-10) {
      issues.push({ severity: "warning", code: "suspiciousCoeff", path: [...path, "coeff"], message: `${context}: coeff is 1 (may indicate configuration error)` });
    }
  };

  const validateEffect = (effect: Effect, context: string, path: (string | number)[]): void => {
    const problem = checkTarget(state, { registry }, effect.target);
    if (problem?.code === "unresolvablePath") {
      error(problem.code, [...path, "target", "path"], `${context}: effect target path cannot be resolved for ${effect.target.kind}:${effect.target.code}:${effect.target.path}`);
    } else if (problem) {
      error(problem.code, [...path, "target", "code"], `${context}: effect targets unknown ${effect.target.kind} "${effect.target.code}"`);
    }

    if (!effectTypes.lookup(effect.type)) {
      error("unknownEffectType", [...path, "type"], `${context}: unknown effect type "${effect.type}"`);
    }

    validateGrowthFunction(effect.func, `${context} func`, [...path, "func"]);
  };

  const validateEndpoint = (prestigeIndex: number, code: string, which: "source" | "target", endpoint: Target): void => {
    const problem = checkTarget(state, { registry }, endpoint);
    const path = ["prestiges", prestigeIndex, which];
    if (problem?.code === "unresolvablePath") {
      error(problem.code, [...path, "path"], `Prestige ${code}: ${which} path cannot be resolved for ${endpoint.kind}:${endpoint.code}:${endpoint.path}`);
    } else if (problem) {
      error(problem.code, [...path, "code"], `Prestige ${code}: ${which} targets unknown ${endpoint.kind} "${endpoint.code}"`);
    }
  };

  state.producers.forEach((producer, index) => {
    const path = ["producers", index];
    producer.produces.forEach((produced, producedIndex) => {
      if (!registry.findGrowableByCode(state, produced.code)) {
        error("unknownGrowable", [...path, "produces", producedIndex, "code"], `Producer ${producer.code}: produces reference to unknown code "${produced.code}"`);
      }
    });

    validateGrowthFunction(producer.scaling, `producer ${producer.code} scaling`, [...path, "scaling"]);

    if (producer.capacity) {
      const capacity = producer.capacity;
      const positive: DefinitionRange = { min: 0, minExclusive: true };
      if (N(capacity.base).lte(0)) {
        error("outOfRange", [...path, "capacity", "base"], `Producer ${producer.code}: capacity.base must be > 0`, positive);
      }
      if (N(capacity.factor).lte(0)) {
        error("outOfRange", [...path, "capacity", "factor"], `Producer ${producer.code}: capacity.factor must be > 0`, positive);
      }
      if (capacity.decayScale <= 0) {
        error("outOfRange", [...path, "capacity", "decayScale"], `Producer ${producer.code}: capacity.decayScale must be > 0`, positive);
      }
      if (capacity.overflowRate !== undefined && capacity.overflowRate < 0) {
        error("outOfRange", [...path, "capacity", "overflowRate"], `Producer ${producer.code}: capacity.overflowRate must be >= 0`, { min: 0 });
      }
    }
  });

  state.upgrades.forEach((upgrade, index) => {
    const path = ["upgrades", index];
    upgrade.effects.forEach((effect, effectIndex) => validateEffect(effect, `Upgrade ${upgrade.code}`, [...path, "effects", effectIndex]));

    validateGrowthFunction(upgrade.scaling, `upgrade ${upgrade.code} scaling`, [...path, "scaling"]);

    (upgrade.behaviors ?? []).forEach((behavior, behaviorIndex) => {
      const prestigeCode = behavior.prestigeCode;
      if (isSet(prestigeCode) && !prestigeCodes.has(prestigeCode)) {
        error(
          "unknownPrestige",
          [...path, "behaviors", behaviorIndex, "prestigeCode"],
          `Upgrade ${upgrade.code}: behavior "${behavior.kind}" references unknown prestige "${prestigeCode}"`,
        );
      }
    });
  });

  state.prestiges.forEach((prestige, index) => {
    const path = ["prestiges", index];
    validateEndpoint(index, prestige.code, "source", prestige.source);
    validateEndpoint(index, prestige.code, "target", prestige.target);

    validateGrowthFunction(prestige.func, `prestige ${prestige.code}`, [...path, "func"]);

    prestige.effects.forEach((effect, effectIndex) => validateEffect(effect, `Prestige ${prestige.code}`, [...path, "effects", effectIndex]));
  });

  const saturation = state.rules?.saturation;
  if (saturation) {
    const checkCurrency = (code: string | undefined, label: string, path: string[]): void => {
      if (isSet(code) && !currencyCodes.has(code)) {
        error("unknownCurrency", ["rules", "saturation", ...path], `rules.saturation.${label}: unknown currency "${code}"`);
      }
    };
    checkCurrency(saturation.overflowCurrencyCode, "overflowCurrencyCode", ["overflowCurrencyCode"]);
    checkCurrency(saturation.gate?.currencyCode, "gate.currencyCode", ["gate", "currencyCode"]);
    checkCurrency(saturation.push?.currencyCode, "push.currencyCode", ["push", "currencyCode"]);
  }

  return issues;
}

/**
 * Validates a game's bootstrap state before the engine's first tick (see
 * `walkState` for the rules).
 *
 * Performs no logging: the caller reports `errors`/`warnings` through its own `Logger`.
 */
export function validateBootstrap(state: GameState, services: EngineServices): ValidationResult {
  const start = performance.now();

  const issues = walkState(state, services);
  const errors = issues.filter((i) => i.severity === "error").map((i) => i.message);
  const warnings = issues.filter((i) => i.severity === "warning").map((i) => i.message);

  const timeMs = performance.now() - start;

  const report: BootstrapReport = {
    producers: state.producers.length,
    currencies: state.currencies.length,
    upgrades: state.upgrades.length,
    prestiges: state.prestiges.length,
    pathsCompiled: 0,
    validationErrors: errors,
    validationWarnings: warnings,
    timeMs,
  };

  return { errors, warnings, report };
}
