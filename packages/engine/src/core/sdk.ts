import { ScaleOn, ScalingMethod } from "../models/base";
import { parseDataPack } from "../models/schema";
import { Decimal, N, NR, print, printF } from "../nums";
import type { Engine } from "./engine";
import type { EffectTypeDef } from "./registries/effect";
import type { GrowthMethodDef } from "./registries/growth";
import type { StageDef } from "./registries/stage";

/**
 * The surface a plugin gets: registry access bound to one engine, plus the
 * numeric and schema utilities needed to build growth methods, effect types
 * and stages.
 */
export interface EngineSdk {
  engine: Engine;

  registerGrowth: (def: GrowthMethodDef, allowOverride?: boolean) => void;
  lookupGrowth: (id: string) => GrowthMethodDef | undefined;
  listGrowths: () => GrowthMethodDef[];
  unregisterGrowth: (id: string) => boolean;

  registerEffectType: (def: EffectTypeDef) => void;
  lookupEffectType: (id: string) => EffectTypeDef | undefined;
  listEffectTypes: (stage?: 0 | 1 | 2) => EffectTypeDef[];
  unregisterEffectType: (id: string) => boolean;

  registerStage: (def: StageDef, allowOverride?: boolean) => void;
  lookupStage: (id: string) => StageDef | undefined;
  listStages: () => StageDef[];
  unregisterStage: (id: string) => boolean;

  parseDataPack: typeof parseDataPack;
  N: typeof N;
  NR: typeof NR;
  print: typeof print;
  printF: typeof printF;
  Decimal: typeof Decimal;
  ScalingMethod: typeof ScalingMethod;
  ScaleOn: typeof ScaleOn;
}

/** Builds an SDK bound to `engine`'s registries. */
export function createSdk(engine: Engine): EngineSdk {
  return {
    engine,

    registerGrowth: (def, allowOverride) => engine.growths.register(def, allowOverride),
    lookupGrowth: (id) => engine.growths.lookup(id),
    listGrowths: () => engine.growths.list(),
    unregisterGrowth: (id) => engine.growths.unregister(id),

    registerEffectType: (def) => engine.effectTypes.register(def),
    lookupEffectType: (id) => engine.effectTypes.lookup(id),
    listEffectTypes: (stage) => engine.effectTypes.list(stage),
    unregisterEffectType: (id) => engine.effectTypes.unregister(id),

    registerStage: (def, allowOverride) => engine.stages.register(def, allowOverride),
    lookupStage: (id) => engine.stages.lookup(id),
    listStages: () => engine.stages.list(),
    unregisterStage: (id) => engine.stages.unregister(id),

    parseDataPack,
    N,
    NR,
    print,
    printF,
    Decimal,
    ScalingMethod,
    ScaleOn,
  };
}
