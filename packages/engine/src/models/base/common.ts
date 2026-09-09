import { type Numerus } from "../../nums";

/** An entity identified by a code, unique within its kind. */
export interface Coded {
  code: string;
}

/** An entity the player can hold a quantity of. */
export interface Ownable {
  amount: Numerus;
}

/** An entity whose amount grows over time. */
export interface Growable extends Ownable {
  /**
   * Amount gained per second, recomputed by the engine on every tick.
   * Undefined until the first tick.
   */
  persecDelta?: Numerus;
}

/** An entity that can be bought with a currency or with another entity's stock. */
export interface Buyable extends Ownable {
  /** Units bought so far. Drives the cost curve. */
  bought: Numerus;

  /** Code of the currency (or producer, whose stock is then spent) the cost is paid with. */
  currencyCode: string;

  /** Cost curve: the price of the next unit as a function of `bought`. */
  scaling: GrowthFunction;

  /** Maximum number of units that can be bought. */
  max?: Numerus;
}

/** An entity that a prestige can reset. */
export interface Resettable extends Ownable {
  /** Codes of the prestiges that reset this entity. */
  resetsOn?: string[];

  /** Amount the entity restarts from after a reset. Default 0. */
  resetsTo?: Numerus;
}

/** Points at a numeric field of an entity: `kind` + `code` select the entity, `path` the field. */
export interface Target {
  kind: "producer" | "currency" | "upgrade";
  code: string;
  /**
   * Dot-separated path inside the entity. `*` walks every element of an
   * array (`produces.*.persec`), a number selects one element (`produces.0.persec`).
   */
  path: string;
}

/**
 * A modification of a target value, driven by the quantity of its owner
 * (an upgrade's bought levels, or the drive of a prestige currency).
 */
export interface Effect {
  /** Which of the three upgrade stages of the tick applies this effect. */
  stage: 0 | 1 | 2;

  source?: Target;
  target: Target;

  /** Effect type id from the engine's effect registry (built-ins: `add`, `mult`). */
  type: string;

  /** Computes the effect value from the owner's quantity. */
  func: GrowthFunction;
}

/**
 * A prestige converts the value at `source` into `target` (the prestige
 * currency) through `func`, then resets every entity that lists `code` in
 * its `resetsOn`. Its `effects` are passive bonuses driven by the prestige
 * currency's drive.
 */
export interface Prestige extends Coded {
  currencyCode: string;
  source: Target;
  target: Target;
  effects: Effect[];
  func: GrowthFunction;
}

/** Ids of the built-in growth methods. Custom methods use any other string id. */
export enum ScalingMethod {
  Linear = "linear",
  Geometric = "geometric",
  Exponential = "exponential",
  DoubleExponential = "double_exponential",
  Logarithmic = "logarithmic",
}

/**
 * Which argument of the growth function is the variable.
 *
 * With `self`, the quantity is the variable and `coeff` is the fixed
 * parameter. With `other`, the two swap roles: `coeff` becomes the
 * variable and the quantity becomes the parameter. Built-in formulas, with
 * `x` = quantity and `b` = coeff:
 *
 * | method             | self                | other               |
 * | ------------------ | ------------------- | ------------------- |
 * | linear             | base + b·x + offset | base + x·b + offset |
 * | geometric          | base · b^x + offset | base · x^b + offset |
 * | exponential        | base^(b·x) + offset | base^(x·b) + offset |
 * | double_exponential | base^(b^x) + offset | base^(x^b) + offset |
 * | logarithmic        | base · b · log10(x) + offset (never swaps)   |
 */
export enum ScaleOn {
  self = "self",
  other = "other",
}

/**
 * A parametric curve `f(quantity)` used everywhere a number depends on a
 * quantity: cost curves, effect values, prestige conversions.
 */
export interface GrowthFunction {
  base: Numerus;
  coeff: Numerus;
  offset?: Numerus;
  /** Growth method id from the engine's growth registry (see `ScalingMethod` for the built-ins). */
  func: string;
  scaleOn: ScaleOn;
}
