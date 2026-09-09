import type { Effect, GrowthFunction } from "../models/base";
import { type GenericNumberInput, N } from "../nums";
import type { BootstrapReport, GameState } from "../state";
import type { EngineServices } from "./di/types";

export interface ValidationResult {
  errors: string[];
  warnings: string[];
  report: BootstrapReport;
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

/**
 * Validates a game's bootstrap state before the engine's first tick:
 * - unique codes within each entity group;
 * - every target reference (produces, effects, prestige source/target) resolves;
 * - every growth function names a registered method and stays inside its domain;
 * - every effect names a registered effect type;
 * - behavior and saturation-rule references name existing prestiges/currencies;
 * - producer capacity parameters stay in range.
 *
 * Performs no logging: the caller reports `errors`/`warnings` through its own `Logger`.
 */
export function validateBootstrap(state: GameState, services: EngineServices): ValidationResult {
  const { registry, growths, effectTypes } = services;
  const errors: string[] = [];
  const warnings: string[] = [];
  const start = performance.now();

  const producerCount = state.producers.length;
  const currencyCount = state.currencies.length;
  const upgradeCount = state.upgrades.length;
  const prestigeCount = state.prestiges.length;

  const producerCodes = new Set<string>();
  for (const producer of state.producers) {
    if (producerCodes.has(producer.code)) {
      errors.push(`Duplicate producer code: ${producer.code}`);
    }
    producerCodes.add(producer.code);
  }

  const currencyCodes = new Set<string>();
  for (const currency of state.currencies) {
    if (currencyCodes.has(currency.code)) {
      errors.push(`Duplicate currency code: ${currency.code}`);
    }
    currencyCodes.add(currency.code);
  }

  const upgradeCodes = new Set<string>();
  for (const upgrade of state.upgrades) {
    if (upgradeCodes.has(upgrade.code)) {
      errors.push(`Duplicate upgrade code: ${upgrade.code}`);
    }
    upgradeCodes.add(upgrade.code);
  }

  const prestigeCodes = new Set<string>();
  for (const prestige of state.prestiges) {
    if (prestigeCodes.has(prestige.code)) {
      errors.push(`Duplicate prestige code: ${prestige.code}`);
    }
    prestigeCodes.add(prestige.code);
  }

  const validateGrowthFunction = (func: GrowthFunction, context: string): void => {
    const def = growths.lookup(func.func);
    if (!def) {
      errors.push(`${context}: unknown growth method "${func.func}"`);
      return;
    }

    const baseNum = toNumber(func.base);
    const coeffNum = toNumber(func.coeff);
    const domain = def.capabilities.domain;

    if (domain?.base) {
      if (domain.base.min !== undefined && (isNaN(baseNum) || baseNum < domain.base.min)) {
        errors.push(`${context}: base must be >= ${domain.base.min}`);
      }
      if (domain.base.max !== undefined && (isNaN(baseNum) || baseNum > domain.base.max)) {
        errors.push(`${context}: base must be <= ${domain.base.max}`);
      }
    }

    if (domain?.coeff) {
      if (domain.coeff.min !== undefined && (isNaN(coeffNum) || coeffNum < domain.coeff.min)) {
        errors.push(`${context}: coeff must be >= ${domain.coeff.min}`);
      }
      if (domain.coeff.max !== undefined && (isNaN(coeffNum) || coeffNum > domain.coeff.max)) {
        errors.push(`${context}: coeff must be <= ${domain.coeff.max}`);
      }
    }

    if (UNIT_COEFF_WARNING_METHODS.has(func.func) && !isNaN(coeffNum) && Math.abs(coeffNum - 1) < 1e-10) {
      warnings.push(`${context}: coeff is 1 (may indicate configuration error)`);
    }
  };

  const validateEffect = (effect: Effect, context: string): void => {
    const targetEntity = registry.getByCode(state, effect.target.kind, effect.target.code);
    if (!targetEntity) {
      errors.push(`${context}: effect targets unknown ${effect.target.kind} "${effect.target.code}"`);
    } else {
      const resolved = registry.getAccessor(effect.target).resolve(state);
      if (!resolved) {
        errors.push(`${context}: effect target path cannot be resolved for ${effect.target.kind}:${effect.target.code}:${effect.target.path}`);
      }
    }

    if (!effectTypes.lookup(effect.type)) {
      errors.push(`${context}: unknown effect type "${effect.type}"`);
    }

    validateGrowthFunction(effect.func, `${context} func`);
  };

  for (const producer of state.producers) {
    for (const produced of producer.produces) {
      const target = registry.findGrowableByCode(state, produced.code);
      if (!target) {
        errors.push(`Producer ${producer.code}: produces reference to unknown code "${produced.code}"`);
      }
    }

    validateGrowthFunction(producer.scaling, `producer ${producer.code} scaling`);

    if (producer.capacity) {
      const capacity = producer.capacity;
      if (N(capacity.base).lte(0)) {
        errors.push(`Producer ${producer.code}: capacity.base must be > 0`);
      }
      if (N(capacity.factor).lte(0)) {
        errors.push(`Producer ${producer.code}: capacity.factor must be > 0`);
      }
      if (capacity.decayScale <= 0) {
        errors.push(`Producer ${producer.code}: capacity.decayScale must be > 0`);
      }
      if (capacity.overflowRate !== undefined && capacity.overflowRate < 0) {
        errors.push(`Producer ${producer.code}: capacity.overflowRate must be >= 0`);
      }
    }
  }

  for (const upgrade of state.upgrades) {
    for (const effect of upgrade.effects) {
      validateEffect(effect, `Upgrade ${upgrade.code}`);
    }

    validateGrowthFunction(upgrade.scaling, `upgrade ${upgrade.code} scaling`);

    for (const behavior of upgrade.behaviors ?? []) {
      const prestigeCode = behavior.prestigeCode;
      if (prestigeCode && !prestigeCodes.has(prestigeCode)) {
        errors.push(`Upgrade ${upgrade.code}: behavior "${behavior.kind}" references unknown prestige "${prestigeCode}"`);
      }
    }
  }

  for (const prestige of state.prestiges) {
    const sourceEntity = registry.getByCode(state, prestige.source.kind, prestige.source.code);
    if (!sourceEntity) {
      errors.push(`Prestige ${prestige.code}: source targets unknown ${prestige.source.kind} "${prestige.source.code}"`);
    } else {
      const srcResolved = registry.getAccessor(prestige.source).resolve(state);
      if (!srcResolved) {
        errors.push(`Prestige ${prestige.code}: source path cannot be resolved for ${prestige.source.kind}:${prestige.source.code}:${prestige.source.path}`);
      }
    }

    const targetEntity = registry.getByCode(state, prestige.target.kind, prestige.target.code);
    if (!targetEntity) {
      errors.push(`Prestige ${prestige.code}: target targets unknown ${prestige.target.kind} "${prestige.target.code}"`);
    } else {
      const tgtResolved = registry.getAccessor(prestige.target).resolve(state);
      if (!tgtResolved) {
        errors.push(`Prestige ${prestige.code}: target path cannot be resolved for ${prestige.target.kind}:${prestige.target.code}:${prestige.target.path}`);
      }
    }

    validateGrowthFunction(prestige.func, `prestige ${prestige.code}`);

    for (const effect of prestige.effects) {
      validateEffect(effect, `Prestige ${prestige.code}`);
    }
  }

  const saturation = state.rules?.saturation;
  if (saturation) {
    const checkCurrency = (code: string | undefined, label: string): void => {
      if (code && !currencyCodes.has(code)) {
        errors.push(`rules.saturation.${label}: unknown currency "${code}"`);
      }
    };
    checkCurrency(saturation.overflowCurrencyCode, "overflowCurrencyCode");
    checkCurrency(saturation.gate?.currencyCode, "gate.currencyCode");
    checkCurrency(saturation.push?.currencyCode, "push.currencyCode");
  }

  const timeMs = performance.now() - start;

  const report: BootstrapReport = {
    producers: producerCount,
    currencies: currencyCount,
    upgrades: upgradeCount,
    prestiges: prestigeCount,
    pathsCompiled: 0,
    validationErrors: errors,
    validationWarnings: warnings,
    timeMs,
  };

  return { errors, warnings, report };
}
