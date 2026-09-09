import type { GameState } from "../../state";
import type { Engine } from "../engine";

/** What a stage receives on every tick. */
export interface StageContext {
  state: GameState;
  /** Milliseconds this tick covers. */
  elapsed: number;
  /** The engine running the tick, for the public stage bodies. */
  engine: Engine;
}

/** One step of the tick pipeline. */
export interface StageDef {
  /** Unique id, also the key of its entry in `stats.stageMetrics`. */
  id: string;

  /** Semantic version of the definition. */
  version: string;

  /**
   * Position in the tick: lower runs first, ties keep registration order.
   * Built-in stages sit at 100, 200, … 700 (see `BUILT_IN_STAGES`); custom
   * stages slot between them.
   */
  priority: number;

  run: (ctx: StageContext) => void;
}

/** Built-in stage ids, in tick order. */
export const BUILT_IN_STAGES = ["Upgrades(0)", "Produce", "Upgrades(1)", "Prestiges", "Growth", "Upgrades(2)", "Automation"] as const;

/** Tick stages of one engine. Seeded with the built-ins unless told otherwise. */
export class StageRegistry {
  private readonly stages = new Map<string, StageDef>();

  constructor(seedBuiltIns = true) {
    if (seedBuiltIns) {
      for (const def of builtInStages()) this.stages.set(def.id, def);
    }
  }

  /** Registers a stage. Throws on a duplicate id unless `allowOverride` is true. */
  register(def: StageDef, allowOverride = false): void {
    if (!def.id || !/^[a-zA-Z0-9_()]+$/.test(def.id)) {
      throw new Error(`Invalid stage id: "${def.id}". Must be alphanumeric and may contain underscores and parentheses.`);
    }
    if (this.stages.has(def.id) && !allowOverride) {
      throw new Error(`Stage "${def.id}" is already registered. Use allowOverride=true to replace it.`);
    }
    this.stages.set(def.id, def);
  }

  lookup(id: string): StageDef | undefined {
    return this.stages.get(id);
  }

  /** Stages in execution order: priority ascending, registration order on ties. */
  list(): StageDef[] {
    return Array.from(this.stages.values()).sort((a, b) => a.priority - b.priority);
  }

  /** Removes a stage. Returns false when it was not registered. */
  unregister(id: string): boolean {
    return this.stages.delete(id);
  }

  count(): number {
    return this.stages.size;
  }
}

/**
 * The tick pipeline: upgrade effects of stage 0, production, stage 1,
 * prestige effects, growth, stage 2, automation. The upgrade stages only apply
 * effects on transient `persecDelta` targets; effects on persistent paths are
 * folded at their point of read inside "Produce".
 */
function builtInStages(): StageDef[] {
  return [
    { id: "Upgrades(0)", version: "1.0.0", priority: 100, run: (ctx) => ctx.engine.applyUpgrades(ctx.state, 0) },
    { id: "Produce", version: "1.0.0", priority: 200, run: (ctx) => ctx.engine.computeProducers(ctx.state, ctx.elapsed) },
    { id: "Upgrades(1)", version: "1.0.0", priority: 300, run: (ctx) => ctx.engine.applyUpgrades(ctx.state, 1) },
    { id: "Prestiges", version: "1.0.0", priority: 400, run: (ctx) => ctx.engine.applyPrestiges(ctx.state) },
    { id: "Growth", version: "1.0.0", priority: 500, run: (ctx) => ctx.engine.applyGrowth(ctx.state, ctx.elapsed) },
    { id: "Upgrades(2)", version: "1.0.0", priority: 600, run: (ctx) => ctx.engine.applyUpgrades(ctx.state, 2) },
    { id: "Automation", version: "1.0.0", priority: 700, run: (ctx) => ctx.engine.runAutomation(ctx.state, ctx.elapsed) },
  ];
}
