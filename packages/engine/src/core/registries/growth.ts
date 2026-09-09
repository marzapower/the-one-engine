import { type Decimal, type Numerus } from "../../nums";
import {
  doubleExponentialCompute,
  doubleExponentialMaxBuyable,
  doubleExponentialSumToN,
  exponentialCompute,
  exponentialMaxBuyable,
  exponentialSumToN,
  geometricCompute,
  geometricMaxBuyable,
  geometricSumToN,
  linearCompute,
  linearMaxBuyable,
  linearSumToN,
  logarithmicCompute,
} from "../growth-formulas";

/**
 * A growth method: the formula behind a `GrowthFunction` id. The engine
 * resolves `scaleOn` before calling these: with `other` the quantity and
 * `coeff` arguments arrive swapped, unless `capabilities.scaleOnOther` is
 * `"quantity"`.
 */
export interface GrowthMethodDef {
  /** Unique id, referenced by `GrowthFunction.func`. */
  id: string;

  /** Semantic version of the definition. */
  version: string;

  /** Value of the curve at `quantity`: F(quantity). */
  compute: (base: Numerus, coeff: Numerus, offset: Numerus, quantity: Numerus) => Decimal;

  /** Closed-form sum of F(C) + F(C+1) + … + F(C+N-1). Optional: without it sums are iterated. */
  sumToN?: (base: Numerus, coeff: Numerus, offset: Numerus, C: Numerus, N: Numerus) => Decimal;

  /** Closed-form largest N whose sum from C fits in budget M. Optional: without it N is searched. */
  maxBuyable?: (base: Numerus, coeff: Numerus, offset: Numerus, C: Numerus, M: Numerus) => Numerus;

  capabilities: {
    hasClosedFormSum: boolean;
    hasClosedFormNmax: boolean;
    /** Valid ranges of the parameters, checked by the bootstrap validation. */
    domain?: {
      base?: { min?: number; max?: number };
      coeff?: { min?: number; max?: number };
    };
    /**
     * What `scaleOn: "other"` means for this method: `"swap"` (default)
     * exchanges quantity and coeff, `"quantity"` keeps the quantity as the
     * variable regardless of `scaleOn`.
     */
    scaleOnOther?: "swap" | "quantity";
  };
}

/** Growth methods available to one engine. Seeded with the built-ins unless told otherwise. */
export class GrowthRegistry {
  private readonly methods = new Map<string, GrowthMethodDef>();

  constructor(seedBuiltIns = true) {
    if (seedBuiltIns) {
      for (const def of BUILT_IN_GROWTHS) this.methods.set(def.id, def);
    }
  }

  /** Registers a method. Throws on a duplicate id unless `allowOverride` is true. */
  register(def: GrowthMethodDef, allowOverride = false): void {
    if (!def.id || !/^[a-z][a-z0-9_]*$/i.test(def.id)) {
      throw new Error(`Invalid growth method id: "${def.id}". Must be alphanumeric and start with a letter.`);
    }
    if (this.methods.has(def.id) && !allowOverride) {
      throw new Error(`Growth method "${def.id}" is already registered. Use allowOverride=true to replace it.`);
    }
    this.methods.set(def.id, def);
  }

  lookup(id: string): GrowthMethodDef | undefined {
    return this.methods.get(id);
  }

  list(): GrowthMethodDef[] {
    return Array.from(this.methods.values());
  }

  /** Removes a method. Returns false when it was not registered. */
  unregister(id: string): boolean {
    return this.methods.delete(id);
  }
}

/** Linear: F(C) = base + coeff·C + offset */
const linearGrowth: GrowthMethodDef = {
  id: "linear",
  version: "1.0.0",
  compute: linearCompute,
  sumToN: linearSumToN,
  maxBuyable: linearMaxBuyable,
  capabilities: {
    hasClosedFormSum: true,
    hasClosedFormNmax: true,
    domain: { base: { min: 0 }, coeff: { min: 0 } },
  },
};

/** Geometric: F(C) = base · coeff^C + offset */
const geometricGrowth: GrowthMethodDef = {
  id: "geometric",
  version: "1.0.0",
  compute: geometricCompute,
  sumToN: geometricSumToN,
  maxBuyable: geometricMaxBuyable,
  capabilities: {
    hasClosedFormSum: true,
    hasClosedFormNmax: true,
    domain: { base: { min: 1e-10 }, coeff: { min: 1e-10 } },
  },
};

/** Exponential: F(C) = base^(coeff·C) + offset */
const exponentialGrowth: GrowthMethodDef = {
  id: "exponential",
  version: "1.0.0",
  compute: exponentialCompute,
  sumToN: exponentialSumToN,
  maxBuyable: exponentialMaxBuyable,
  capabilities: {
    hasClosedFormSum: true,
    hasClosedFormNmax: true,
    domain: { base: { min: 1e-10 }, coeff: { min: 0 } },
  },
};

/** Double exponential: F(C) = base^(coeff^C) + offset */
const doubleExponentialGrowth: GrowthMethodDef = {
  id: "double_exponential",
  version: "1.0.0",
  compute: doubleExponentialCompute,
  sumToN: doubleExponentialSumToN,
  maxBuyable: doubleExponentialMaxBuyable,
  capabilities: {
    hasClosedFormSum: true,
    hasClosedFormNmax: true,
    domain: { base: { min: 1e-10 }, coeff: { min: 1e-10 } },
  },
};

/**
 * Logarithmic: F(C) = base · coeff · log10(C) + offset. Linear in the decades
 * of the quantity: the natural shape of a prestige conversion. Not a cost
 * curve: no closed-form sum or maximum.
 */
const logarithmicGrowth: GrowthMethodDef = {
  id: "logarithmic",
  version: "1.0.0",
  compute: logarithmicCompute,
  capabilities: {
    hasClosedFormSum: false,
    hasClosedFormNmax: false,
    domain: { base: { min: 1e-10 }, coeff: { min: 1e-10 } },
    scaleOnOther: "quantity",
  },
};

export const BUILT_IN_GROWTHS: readonly GrowthMethodDef[] = [linearGrowth, geometricGrowth, exponentialGrowth, doubleExponentialGrowth, logarithmicGrowth];
