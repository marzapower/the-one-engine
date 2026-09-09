import type { Currency, Effect, Prestige, Producer, Target, Upgrade } from "../../models/base";
import type { Decimal, Numerus } from "../../nums";
import type { GameState } from "../../state";
import type { EffectRegistry } from "../registries/effect";
import type { GrowthRegistry } from "../registries/growth";
import type { StageRegistry } from "../registries/stage";

/** Clock the engine ticks against. `advance` makes it steppable for headless runs. */
export interface TimeProvider {
  now(): number;
  getTickLength(): number;
  setTickLength(ms: number): void;
  advance?(ms: number): void;
}

/** Where the engine reports. Defaults to the console; inject a silent one for simulations. */
export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export type MutationType = "setTargetValue" | "setValues" | "addPersecDelta" | "setPersecDelta" | "incrementAmount" | "resetForPrestige";

export interface MutationEvent {
  type: MutationType;
  target?: Target | Producer | Currency | Upgrade;
  value?: unknown;
  timestamp: number;
}

/** Every write the engine performs on the state goes through this seam. */
export interface StateAdapter {
  getAllThings(state: GameState): (Producer | Currency | Upgrade)[];
  getThing(state: GameState, kind: "producer" | "currency" | "upgrade", code: string): Producer | Currency | Upgrade | undefined;
  getTargetValue(state: GameState, target: Target): Numerus | Numerus[] | undefined;
  setTargetValue(state: GameState, target: Target, updater: (value: Decimal) => Numerus): void;
  getProducers(state: GameState): Producer[];
  getCurrencies(state: GameState): Currency[];
  getUpgrades(state: GameState): Upgrade[];
  setRegistry(registry: EntityRegistry): void;
  setValues(state: GameState, objects: unknown[], key: string, updater: (value: Decimal) => Numerus): void;
  addPersecDelta(state: GameState, thing: Producer | Currency, delta: Numerus): void;
  setPersecDelta(state: GameState, thing: Producer | Currency, value: Numerus | undefined): void;
  incrementAmount(state: GameState, thing: Producer | Currency, delta: Numerus): void;
  resetForPrestige(state: GameState, prestigeCode: string): void;
  onBeforeMutation?: (event: MutationEvent) => void;
  onAfterMutation?: (event: MutationEvent) => void;
}

/** Indexes entities by kind and code and compiles target paths into accessors. */
export interface EntityRegistry {
  refresh(state: GameState): void;
  getByCode(state: GameState, kind: "producer" | "currency" | "upgrade", code: string): Producer | Currency | Upgrade | undefined;
  findGrowableByCode(state: GameState, code: string): Producer | Currency | undefined;
  getAllGrowables(state: GameState): (Producer | Currency)[];
  getAccessor(target: Target): CompiledAccessor;
}

export interface CompiledAccessor {
  resolve(state: GameState): { objects: unknown[]; key: string } | undefined;
}

/** Applies one effect to its target through the state adapter. */
export interface EffectResolver {
  apply(state: GameState, effect: Effect, amount: Numerus, services: EngineServices): void;
}

/**
 * The collaborators an engine hands to the pure helpers that need them.
 * Built once by the engine from its dependencies.
 */
export interface EngineServices {
  adapter: StateAdapter;
  registry: EntityRegistry;
  growths: GrowthRegistry;
  effectTypes: EffectRegistry;
  logger: Logger;
}

export type EngineDependencies = {
  time?: TimeProvider;
  state?: StateAdapter;
  registry?: EntityRegistry;
  effects?: EffectResolver;
  logger?: Logger;
  growths?: GrowthRegistry;
  effectTypes?: EffectRegistry;
  stages?: StageRegistry;
  /** Called after every prestige, whether the host or an automation behaviour triggered it. */
  onPrestige?: (state: GameState, prestige: Prestige) => void;
};
