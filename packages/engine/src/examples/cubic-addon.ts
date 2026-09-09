/**
 * Reference addon: registers a cubic growth method, a `pow` effect type and a
 * logging stage on a given engine. Demonstrates how the three registries and
 * the tick pipeline extend without touching engine code.
 */
import type { Engine } from "../core/engine";
import type { EffectTypeDef } from "../core/registries/effect";
import type { GrowthMethodDef } from "../core/registries/growth";
import type { StageContext, StageDef } from "../core/registries/stage";
import { N, NR } from "../nums";

/**
 * Cubic growth: F(C) = base * (C+1)^3 + offset. `coeff` is not part of the
 * formula; the domain declares no constraint on it.
 *
 * Closed-form sum of cubes: S(N) = base * (T(C+N) - T(C)) + offset*N, where
 * T(x) = (x(x+1)/2)^2 is the sum of the first x cubes. No closed-form
 * maximum: callers fall back to a binary search.
 */
const cubicGrowthDef: GrowthMethodDef = {
  id: "cubic",
  version: "1.0.0",
  compute: (base, coeff, offset, quantity) => {
    const q = N(quantity);
    const b = N(base);
    const o = N(offset || 0);
    return b.mul(q.add(1).pow(3)).add(o);
  },
  sumToN: (base, coeff, offset, C, amount) => {
    const b = N(base);
    const cStart = N(C);
    const n = N(amount);
    const o = N(offset || 0);

    const sumOfCubes = (x: ReturnType<typeof N>) => {
      const tri = x.mul(x.add(1)).div(2);
      return tri.mul(tri);
    };

    return b.mul(sumOfCubes(cStart.add(n)).sub(sumOfCubes(cStart))).add(o.mul(n));
  },
  capabilities: {
    hasClosedFormSum: true,
    hasClosedFormNmax: false,
    domain: {
      base: { min: 0 },
    },
  },
};

/** Power effect: apply(prev, computed) = prev ^ computed. Runs after `mult` (200). */
const powEffectDef: EffectTypeDef = {
  id: "pow",
  version: "1.0.0",
  priority: 300,
  apply: (prev, computed) => NR(prev.pow(computed)),
  allowedStages: [0, 1, 2],
};

/** Records when this stage runs, for profiling. Runs after `Upgrades(2)` (600). */
const logTickStageDef: StageDef = {
  id: "LogTick",
  version: "1.0.0",
  priority: 650,
  run: (ctx: StageContext) => {
    ctx.state.stats.lastCallTimes.push(["addon:logtick", Date.now()]);
  },
};

/**
 * Registers the cubic growth method, the `pow` effect type and the `LogTick`
 * stage on `engine`. Throws if the growth method is already registered
 * unless `allowOverride` is true.
 */
export function applyCubicAddon(engine: Engine, allowOverride = false): void {
  if (!allowOverride && engine.growths.lookup("cubic")) {
    throw new Error("Cubic addon already applied. Use applyCubicAddon(engine, true) to override, or removeCubicAddon(engine) first.");
  }

  engine.growths.register(cubicGrowthDef, allowOverride);
  engine.effectTypes.register(powEffectDef);
  engine.stages.register(logTickStageDef, allowOverride);
}

/** Unregisters the cubic addon's growth method, effect type and stage. Safe to call when not applied. */
export function removeCubicAddon(engine: Engine): void {
  engine.growths.unregister("cubic");
  engine.effectTypes.unregister("pow");
  engine.stages.unregister("LogTick");
}

/** True when every cubic addon component is registered on `engine`. */
export function isCubicAddonApplied(engine: Engine): boolean {
  return engine.growths.lookup("cubic") !== undefined && engine.effectTypes.lookup("pow") !== undefined && engine.stages.lookup("LogTick") !== undefined;
}
