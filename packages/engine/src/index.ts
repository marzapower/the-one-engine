// ============================================================================
// Engine
// ============================================================================
export { Engine } from "./core/engine";

// ============================================================================
// SDK & plugins
// ============================================================================
export { createSdk, type EngineSdk } from "./core/sdk";
export { applyPlugin, loadPlugin, type Plugin } from "./core/plugin-loader";

// ============================================================================
// Registries
// ============================================================================
export {
  GrowthRegistry,
  BUILT_IN_GROWTHS,
  type GrowthMethodDef,
  EffectRegistry,
  BUILT_IN_EFFECTS,
  type EffectTypeDef,
  StageRegistry,
  BUILT_IN_STAGES,
  type StageDef,
  type StageContext,
} from "./core/registries";

// ============================================================================
// Models
// ============================================================================
export type {
  Producer,
  ProducerTarget,
  ProducerCapacity,
  Currency,
  PrestigeDrive,
  Upgrade,
  UpgradeBehavior,
  Prestige,
  Effect,
  Target,
  GrowthFunction,
  Coded,
  Ownable,
  Growable,
  Buyable,
  Resettable,
} from "./models/base";
export { ScalingMethod, ScaleOn } from "./models/base";
export { Factory } from "./models/base/factory";
export * from "./models/schema";

// ============================================================================
// Rules
// ============================================================================
export type { GameRules, SaturationRules } from "./rules";

// ============================================================================
// State
// ============================================================================
export type { GameState, EngineStats, StageMetrics, BootstrapReport } from "./state";
export { createInitialState } from "./state";

// ============================================================================
// Constants
// ============================================================================
export { DESIRED_FPS, TICK_MS_INTERVAL, MOVING_AVG_WINDOW, ZERO } from "./constants";

// ============================================================================
// Dependency injection: types and defaults
// ============================================================================
export type {
  TimeProvider,
  Logger,
  StateAdapter,
  EntityRegistry,
  EffectResolver,
  EngineServices,
  EngineDependencies,
  MutationEvent,
  MutationType,
  CompiledAccessor,
} from "./core/di/types";
export { DefaultTimeProvider, DefaultStateAdapter, DefaultEffectResolver, DefaultEntityRegistry, consoleLogger, silentLogger } from "./core/di/defaults";

// ============================================================================
// Pure math: growth, pricing, saturation, prestige gain, modifiers
// ============================================================================
export { computeGrowthFunction, resolveGrowthArgs } from "./core/growth";
export { costToBuyNext, maxBuyableAmount, costToBuy } from "./core/pricing";
export { supportRatio, capacityPush, dragFactor, coolingDelta, type SupportInputs } from "./core/saturation";
export { DEFAULT_PRESTIGE_DRIVE, prestigeDrive, prestigeGainMultiplier, deliveredPrestigeGain } from "./core/prestige-gain";
export { collectModifiers, applyModifiers, isTransientTargetPath, type Modifier } from "./core/modifiers";

// ============================================================================
// Offline simulation
// ============================================================================
export type { OfflineReport } from "./core/offline";

// ============================================================================
// Validation
// ============================================================================
export { validateBootstrap, type ValidationResult } from "./core/validation";

// ============================================================================
// Growth formulas
// ============================================================================
export * from "./core/growth-formulas";

// ============================================================================
// Numeric utilities
// ============================================================================
export { N, NR, print, printF, Decimal, type Numerus, type GenericNumberInput } from "./nums";
