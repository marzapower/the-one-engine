import { z } from "zod";

import { type GenericNumberInput, N } from "../nums";
import type { GameState } from "../state";

/**
 * Zod schemas for runtime data validation. They validate shape, not semantic
 * correctness: whether ids referenced by a state actually exist is checked
 * separately by bootstrap validation. Object schemas use `.strip()` (the zod
 * default) so unknown fields — for instance those a custom growth method or
 * effect type expects — are dropped rather than rejected.
 */

// ============================================================================
// NUMERUS SCHEMA
// ============================================================================
/**
 * Shape validation only: a number, a numeric string, or the raw
 * `{ sign, layer, mag }` form. Whether the value actually parses (via `N()`)
 * is a runtime concern, not a shape one.
 */
export const NumerusSchema = z.union([
  z.number(),
  z.string(),
  z.object({
    sign: z.union([z.literal(1), z.literal(0), z.literal(-1)]),
    layer: z.number(),
    mag: z.number(),
  }),
]);

// ============================================================================
// SCALING & GROWTH FUNCTION SCHEMAS
// ============================================================================
/** Ids of the built-in growth methods; a `GrowthFunction` may reference any other registered id. */
const BUILT_IN_SCALING_METHODS = ["linear", "geometric", "exponential", "double_exponential", "logarithmic"] as const;

/** A growth method id: any non-empty string. Domain constraints below apply only to the built-in ids. */
export const ScalingMethodSchema = z.string().min(1);

export const ScaleOnSchema = z.enum(["self", "other"]);

/**
 * Converts a Numerus-shaped value to a number for the refinement below.
 * Delegates to `N()`: any input it cannot parse becomes `NaN` instead of throwing.
 */
function safeToNumber(val: unknown): number {
  try {
    return N(val as GenericNumberInput).toNumber();
  } catch {
    return NaN;
  }
}

export const GrowthFunctionSchema = z
  .object({
    base: NumerusSchema,
    coeff: NumerusSchema,
    offset: NumerusSchema.optional(),
    func: ScalingMethodSchema,
    scaleOn: ScaleOnSchema,
  })
  .refine(
    (gf) => {
      // Custom growth method ids pass shape validation unconditionally: the
      // engine's growth registry, not this schema, owns their domain.
      if (!(BUILT_IN_SCALING_METHODS as readonly string[]).includes(gf.func)) return true;

      const baseNum = safeToNumber(gf.base);
      if (isNaN(baseNum) || baseNum <= 0) return false;

      if (gf.func !== "linear") {
        const coeffNum = safeToNumber(gf.coeff);
        if (isNaN(coeffNum) || coeffNum <= 0) return false;
      }

      if (gf.func === "double_exponential" && baseNum <= 1) return false;

      return true;
    },
    { message: "GrowthFunction domain constraint violated (see func type)" },
  );

// ============================================================================
// TARGET SCHEMA
// ============================================================================
export const TargetSchema = z.object({
  kind: z.enum(["producer", "currency", "upgrade"]),
  code: z.string(),
  path: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.*]*$/, "path must start with letter/underscore, contain letters/digits/underscore/dot/asterisk"),
});

// ============================================================================
// EFFECT SCHEMA
// ============================================================================
export const EffectSchema = z.object({
  stage: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  source: TargetSchema.optional(),
  target: TargetSchema,
  /** Effect type id: any non-empty string, resolved against the engine's effect registry. */
  type: z.string().min(1),
  func: GrowthFunctionSchema,
});

// ============================================================================
// PRODUCER SCHEMAS
// ============================================================================
export const ProducerTargetSchema = z.object({
  code: z.string(),
  persec: NumerusSchema,
  persecEffective: NumerusSchema.optional(),
});

export const ProducerCapacitySchema = z.object({
  base: NumerusSchema,
  factor: NumerusSchema,
  decayScale: z.number(),
  overflowRate: z.number().optional(),
});

export const ProducerSchema = z.object({
  code: z.string(),
  name: z.string(),
  sub: z.string().optional(),
  amount: NumerusSchema,
  bought: NumerusSchema,
  currencyCode: z.string(),
  scaling: GrowthFunctionSchema,
  produces: z.array(ProducerTargetSchema),
  persecDelta: NumerusSchema.optional(),
  resetsOn: z.array(z.string()).optional(),
  resetsTo: NumerusSchema.optional(),
  max: NumerusSchema.optional(),
  priority: z.number().optional(),
  capacity: ProducerCapacitySchema.optional(),
});

// ============================================================================
// CURRENCY SCHEMA
// ============================================================================
export const PrestigeDriveSchema = z.object({
  unspentWeight: z.number(),
  earnedWeight: z.number(),
});

export const CurrencySchema = z.object({
  code: z.string(),
  name: z.string(),
  amount: NumerusSchema,
  primary: z.boolean().optional(),
  earned: NumerusSchema.optional(),
  drive: PrestigeDriveSchema.optional(),
  capacityMult: NumerusSchema.optional(),
  gainMult: NumerusSchema.optional(),
  coolingMult: NumerusSchema.optional(),
  persecDelta: NumerusSchema.optional(),
  resetsOn: z.array(z.string()).optional(),
  resetsTo: NumerusSchema.optional(),
});

// ============================================================================
// UPGRADE SCHEMA
// ============================================================================
export const UpgradeBehaviorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("autobuyUpgrades"), prestigeCode: z.string().optional() }),
  z.object({ kind: z.literal("prestigeDrip"), prestigeCode: z.string(), ratePerSecond: z.number() }),
  z.object({ kind: z.literal("autoPrestige"), prestigeCode: z.string(), ratio: z.number() }),
  z.object({ kind: z.literal("keepLevels"), prestigeCode: z.string(), fraction: z.number() }),
]);

export const UpgradeSchema = z.object({
  code: z.string(),
  name: z.string(),
  desc: z.string().optional(),
  summary: z.string().optional(),
  amount: NumerusSchema,
  bought: NumerusSchema,
  currencyCode: z.string(),
  scaling: GrowthFunctionSchema,
  effects: z.array(EffectSchema),
  behaviors: z.array(UpgradeBehaviorSchema).optional(),
  resetsOn: z.array(z.string()).optional(),
  resetsTo: NumerusSchema.optional(),
  max: NumerusSchema.optional(),
});

// ============================================================================
// PRESTIGE SCHEMA
// ============================================================================
export const PrestigeSchema = z.object({
  code: z.string(),
  currencyCode: z.string(),
  source: TargetSchema,
  target: TargetSchema,
  effects: z.array(EffectSchema),
  func: GrowthFunctionSchema,
});

// ============================================================================
// RULES SCHEMA
// ============================================================================
export const SaturationRulesSchema = z.object({
  decayExponent: z.number().optional(),
  overflowCurrencyCode: z.string().optional(),
  gate: z.object({ currencyCode: z.string(), earnedAtLeast: z.number() }).optional(),
  push: z.object({ currencyCode: z.string(), exponent: z.number() }).optional(),
  drag: z.object({ onset: z.number(), scale: z.number(), exponent: z.number(), floor: z.number() }).optional(),
  cooling: z.object({ halfLifeMs: z.number() }).optional(),
});

export const GameRulesSchema = z.object({
  saturation: SaturationRulesSchema.optional(),
});

// ============================================================================
// STATS SCHEMA
// ============================================================================
export const StageMetricsSchema = z.object({
  count: z.number(),
  totalMs: z.number(),
  avgMs: z.number(),
  minMs: z.number(),
  maxMs: z.number(),
  lastMs: z.number(),
});

export const BootstrapReportSchema = z.object({
  producers: z.number(),
  currencies: z.number(),
  upgrades: z.number(),
  prestiges: z.number(),
  pathsCompiled: z.number(),
  validationErrors: z.array(z.string()),
  validationWarnings: z.array(z.string()),
  timeMs: z.number(),
});

/** A finite number, or +/-Infinity: `EngineStats.minTime` starts at `Infinity` until the first tick. */
const NumberOrInfinitySchema = z.union([z.number(), z.literal(Infinity), z.literal(-Infinity)]);

export const StatsSchema = z.object({
  avgTime: z.number(),
  minTime: NumberOrInfinitySchema,
  maxTime: NumberOrInfinitySchema,
  totalTime: z.number(),
  ticks: z.number(),
  lastTicks: z.array(z.number()),
  movingAvgTime: z.number(),
  fastSkippedFrames: z.number(),
  slowSkippedFrames: z.number(),
  lastCallTimes: z.array(z.tuple([z.string(), z.number()])),
  stageMetrics: z.record(z.string(), StageMetricsSchema),
  bootstrapReport: BootstrapReportSchema.optional(),
  validationErrors: z.array(z.string()),
  validationWarnings: z.array(z.string()),
  overflowPerSec: z.number(),
  overflowByProducer: z.record(z.string(), z.number()),
});

// ============================================================================
// GAME STATE SCHEMA
// ============================================================================
/** `stats` uses `.passthrough()` so fields added by future stats are not rejected. */
export const GameStateSchema = z.object({
  stats: StatsSchema.passthrough(),
  lastTick: z.number().optional(),
  producers: z.array(ProducerSchema),
  upgrades: z.array(UpgradeSchema),
  currencies: z.array(CurrencySchema),
  prestiges: z.array(PrestigeSchema),
  rules: GameRulesSchema.optional(),
});

// ============================================================================
// DATA PACK SCHEMA
// ============================================================================
/** Wrapper for a versioned, engine-agnostic data payload. */
export const DataPackSchema = z.object({
  schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/, "must be semantic version"),
  payload: z.unknown(),
});

// ============================================================================
// PARSE HELPERS
// ============================================================================
export interface ParseResult<T> {
  valid: boolean;
  data?: T;
  errors: string[];
  warnings: string[];
}

function parseWithSchema<T>(schema: z.ZodType<T>, input: unknown): ParseResult<T> {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    const parsed = schema.parse(input);
    return { valid: true, data: parsed, errors, warnings };
  } catch (err) {
    if (err instanceof z.ZodError) {
      for (const issue of err.issues) {
        const path = issue.path.length > 0 ? issue.path.join(".") : "root";
        errors.push(`${path}: ${issue.message}`);
      }
    } else if (err instanceof Error) {
      errors.push(err.message);
    } else {
      errors.push("Unknown validation error");
    }
    return { valid: false, errors, warnings };
  }
}

/** Validates the shape of a `GameState`. Non-throwing. */
export function parseGameState(input: unknown): ParseResult<GameState> {
  return parseWithSchema(GameStateSchema as unknown as z.ZodType<GameState>, input);
}

/** Validates the shape of a versioned data payload. Non-throwing. */
export function parseDataPack(input: unknown): ParseResult<unknown> {
  return parseWithSchema(DataPackSchema, input);
}
