import Decimal from "break_eternity.js";

// The single re-export point for Decimal: nothing else in the engine, and no
// consumer of it, should import break_eternity.js directly.
export { Decimal };

/** Persistable raw form of a number: a flat, serializable copy of Decimal's three internal fields. */
export interface Numerus {
  sign: number;
  layer: number;
  mag: number;
}

export type GenericNumberInput = Decimal | Numerus | number | string;

// A "zero literal" numeric string (e.g. "0", "-0.0", "0e5"): if Decimal.fromString
// reduces it to 0 but the string does not match this pattern, the input was invalid
// (Decimal silently returns 0 for unparseable strings, e.g. "abc").
// At least one "0" digit is required: "", " ", "+", "-", "." are reduced to 0 by
// Decimal but are not zero literals.
const ZERO_LITERAL_REGEX = /^\s*[-+]?(0+\.?0*|\.0+)(e[-+]?\d+)?\s*$/i;
const isZeroLiteralString = (s: string): boolean => ZERO_LITERAL_REGEX.test(s);

const isRawNumerus = (n: unknown): n is Numerus =>
  typeof n === "object" && n !== null && !(n instanceof Decimal) && typeof (n as Numerus).layer === "number" && typeof (n as Numerus).mag === "number";

const isLegacyNumerus = (n: unknown): boolean => typeof n === "object" && n !== null && Array.isArray((n as { array?: unknown }).array);

/**
 * Converts a generic input into a Decimal instance.
 * Unlike `new Decimal(...)`, which silently returns 0 for invalid input, this
 * function is deliberately strict and throws `TypeError` on ambiguous or
 * unsupported input (undefined/null, arrays, the legacy {sign, array} format, etc.).
 */
export const N = (n: GenericNumberInput): Decimal => {
  if (n instanceof Decimal) return n;
  if (typeof n === "number") return Decimal.fromNumber(n);
  if (typeof n === "string") {
    const result = Decimal.fromString(n);
    if (result.eq(0) && !isZeroLiteralString(n)) {
      throw new TypeError(`[nums] Invalid numeric string: ${n}`);
    }
    return result;
  }
  if (isLegacyNumerus(n)) {
    throw new TypeError("[nums] Legacy Numerus format {sign, array} is no longer supported");
  }
  if (isRawNumerus(n)) {
    return Decimal.fromComponents(n.sign, n.layer, n.mag);
  }
  throw new TypeError(`[nums] Invalid numeric input: ${JSON.stringify(n)}`);
};

/** Converts a generic input into the flat raw form { sign, layer, mag }. */
export const NR = (n: GenericNumberInput): Numerus => {
  const d = N(n);
  return { sign: d.sign, layer: d.layer, mag: d.mag };
};

type PrintOptions = { precision?: number; decimals?: number; fractional?: boolean };

// --- Formatting algorithm.
//
// A Decimal is internally `sign · 10^^layer · 10^mag` (`mag` is the exponent
// at the current `layer`, `layer` counts how many times 10 has been stacked
// as a tower). Formatting walks that representation outward one layer at a
// time, each step folding the previous layer's magnitude down into a decimal
// exponent, until what remains renders as a plain number:
//
// - `layer === 0`: render `mag` as a plain decimal number (with grouping).
// - `layer` 1 or 2: render as `e^layer` followed by the mantissa and a "e"
//   exponent, e.g. "1.23e6" (layer 1) or "e1.23e20" (layer 2).
// - `layer` 3 to 7: too large for a mantissa/exponent pair to stay readable;
//   render as a chain of "e" prefixes followed by `mag` itself, e.g. "eee10.00".
// - `layer` 8 and above: render as "(10^)^N mag", spelling out the tower
//   height explicitly instead of stacking more "e" prefixes.
//
// A `mag` above the working precision (`10^precision`) is first folded into
// one more layer (`mag = log10(mag); layer++`) before the layer switch above
// runs, so the boundary between layers stays exactly at the precision cutoff.

const toPrecision = (num: number, places: number): number => {
  const len = places + 1;
  let numDigits = Math.ceil(Math.log10(Math.abs(num)));
  if (numDigits < 100) numDigits = 0;
  const rounded = Math.round(num * Math.pow(10, len - numDigits)) * Math.pow(10, numDigits - len);
  return rounded;
};

const decimalPlaces = (num: number, places: number): number => parseFloat(num.toFixed(Math.min(20, Math.max(0, places))));

const toPrecisionWithDecimalPlaces = (num: number, precision: number, decimals: number): string => {
  const num2 = decimalPlaces(toPrecision(num, precision), decimals);
  return num2.toLocaleString(undefined, decimals > 0 ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals } : {});
};

export const print = (num: GenericNumberInput | undefined, opts?: PrintOptions): string => {
  const { precision = 6, decimals = 2, fractional = false } = opts ?? {};
  const d = N(num ?? 0);

  if (d.sign === -1) return "-" + print(d.abs(), opts);
  if (d.isNan()) return "NaN";
  if (!d.isFinite()) return "Infinity";

  let k = d.mag;
  let l = d.layer;
  const m = Math.pow(10, precision);

  // A number just below layer 1 (magnitude around 1e-16 and smaller) can carry
  // layer 1 with a negative mag; that combination renders as if it were layer 0.
  if (l >= 1 && k < 0) {
    return toPrecisionWithDecimalPlaces(d.toNumber(), precision, fractional ? decimals : 0);
  }

  if (k > m) {
    k = Math.log10(k);
    l++;
  }

  if (l === 0) return toPrecisionWithDecimalPlaces(k, precision, fractional ? decimals : 0);
  if (l < 3)
    return "e".repeat(l - 1) + toPrecisionWithDecimalPlaces(Math.pow(10, k - Math.floor(k)), precision, decimals) + "e" + toPrecisionWithDecimalPlaces(Math.floor(k), precision, 0);
  if (l < 8) return "e".repeat(l) + toPrecisionWithDecimalPlaces(k, precision, decimals);
  return "(10^)^" + l + " " + toPrecisionWithDecimalPlaces(k, precision, decimals);
};

export const printF = (num: GenericNumberInput | undefined, opts?: PrintOptions): string => print(num, { ...opts, fractional: true });
