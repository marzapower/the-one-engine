import { type GrowthFunction, ScaleOn } from "../models/base";
import { type Decimal, type GenericNumberInput, NR, type Numerus } from "../nums";
import type { GrowthMethodDef, GrowthRegistry } from "./registries/growth";

/**
 * Resolves a `GrowthFunction` and a quantity into the four arguments a
 * growth method's `compute`/`sumToN`/`maxBuyable` expect: `(base, coeff,
 * offset, quantity)`.
 *
 * With `scaleOn: "self"` the quantity is the variable and `coeff` stays the
 * fixed parameter. With `scaleOn: "other"` the two swap roles — `coeff`
 * becomes the resolved quantity and the given quantity becomes the resolved
 * coeff — unless the method declares `capabilities.scaleOnOther ===
 * "quantity"`, in which case the quantity stays the variable regardless of
 * `scaleOn`.
 */
export function resolveGrowthArgs(func: GrowthFunction, quantity: GenericNumberInput, def: GrowthMethodDef): { base: Numerus; coeff: Numerus; offset: Numerus; quantity: Numerus } {
  const base = NR(func.base);
  const offset = NR(func.offset ?? 0);
  const q = NR(quantity);

  if (func.scaleOn === ScaleOn.other && def.capabilities.scaleOnOther !== "quantity") {
    return { base, coeff: q, offset, quantity: NR(func.coeff) };
  }

  return { base, coeff: NR(func.coeff), offset, quantity: q };
}

/**
 * Computes the value of a `GrowthFunction` at `quantity` using the method
 * registered under `func.func`.
 */
export function computeGrowthFunction(func: GrowthFunction, quantity: GenericNumberInput, growths: GrowthRegistry): Decimal {
  const def = growths.lookup(func.func);
  if (!def) {
    throw new Error(`Unknown growth method "${func.func}"`);
  }

  const args = resolveGrowthArgs(func, quantity, def);
  return def.compute(args.base, args.coeff, args.offset, args.quantity);
}
