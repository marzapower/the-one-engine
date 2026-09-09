import { ZERO } from "../../constants";
import type { Coded, Currency, Effect, Producer, Target, Upgrade } from "../../models/base";
import { Decimal, N, NR, type Numerus } from "../../nums";
import type { GameState } from "../../state";
import { computeGrowthFunction } from "../growth";
import type { CompiledAccessor, EffectResolver, EngineServices, EntityRegistry, MutationEvent, StateAdapter, TimeProvider } from "./types";

export class DefaultTimeProvider implements TimeProvider {
  private tickLength: number;
  constructor(tickLength: number) {
    this.tickLength = tickLength;
  }

  now(): number {
    const perf = typeof window !== "undefined" && "performance" in window ? window.performance : undefined;
    return perf && typeof perf.now === "function" ? perf.now() : Date.now();
  }

  getTickLength(): number {
    return this.tickLength;
  }

  setTickLength(ms: number): void {
    this.tickLength = ms;
  }
}

/**
 * Reads and writes state exclusively through the entity registry's compiled
 * accessors: a target is only ever resolved by looking up its owning entity
 * by kind/code and walking its path, never by traversing an ad hoc object
 * graph. The registry is optional at construction so a fresh adapter can be
 * built before its engine's registry exists; `setRegistry` connects the two.
 */
export class DefaultStateAdapter implements StateAdapter {
  private registry?: EntityRegistry;
  private accessorCache = new Map<string, CompiledAccessor>();
  public onBeforeMutation?: (event: MutationEvent) => void;
  public onAfterMutation?: (event: MutationEvent) => void;

  constructor(registry?: EntityRegistry) {
    this.registry = registry;
  }

  private fire(phase: "before" | "after", event: Omit<MutationEvent, "timestamp">): void {
    const hook = phase === "before" ? this.onBeforeMutation : this.onAfterMutation;
    if (hook) hook({ ...event, timestamp: Date.now() });
  }

  setRegistry(registry: EntityRegistry): void {
    this.registry = registry;
    this.accessorCache.clear();
  }

  private keyFor(target: Target): string {
    return `${target.kind}:${target.code}:${target.path}`;
  }

  private accessorFor(target: Target): CompiledAccessor | undefined {
    if (!this.registry) return undefined;
    const key = this.keyFor(target);
    let acc = this.accessorCache.get(key);
    if (!acc) {
      acc = this.registry.getAccessor(target);
      this.accessorCache.set(key, acc);
    }
    return acc;
  }

  getAllThings(state: GameState): (Producer | Currency | Upgrade)[] {
    return [...state.producers, ...state.currencies, ...state.upgrades];
  }

  getProducers(state: GameState): Producer[] {
    return state.producers;
  }

  getCurrencies(state: GameState): Currency[] {
    return state.currencies;
  }

  getUpgrades(state: GameState): Upgrade[] {
    return state.upgrades;
  }

  getThing(state: GameState, kind: "producer" | "currency" | "upgrade", code: string): Producer | Currency | Upgrade | undefined {
    const list: Coded[] = kind === "producer" ? state.producers : kind === "currency" ? state.currencies : state.upgrades;
    return list.find((t) => t.code === code) as Producer | Currency | Upgrade | undefined;
  }

  getTargetValue(state: GameState, target: Target): Numerus | Numerus[] | undefined {
    const resolved = this.accessorFor(target)?.resolve(state);
    if (!resolved) return undefined;
    const { objects, key } = resolved;
    const vals: Numerus[] = [];
    for (const obj of objects) {
      if (typeof obj !== "object" || obj === null) continue;
      const v = (obj as Record<string, unknown>)[key] as Numerus | undefined;
      if (typeof v !== "undefined") vals.push(v);
    }
    if (vals.length === 0) return undefined;
    return vals.length === 1 ? vals[0]! : vals;
  }

  setTargetValue(state: GameState, target: Target, updater: (value: Decimal) => Numerus): void {
    this.fire("before", { type: "setTargetValue", target });
    const resolved = this.accessorFor(target)?.resolve(state);
    if (resolved) this.setValuesInner(resolved.objects, resolved.key, updater);
    this.fire("after", { type: "setTargetValue", target });
  }

  setValues(_state: GameState, objects: unknown[], key: string, updater: (value: Decimal) => Numerus): void {
    this.fire("before", { type: "setValues" });
    this.setValuesInner(objects, key, updater);
    this.fire("after", { type: "setValues" });
  }

  private setValuesInner(objects: unknown[], key: string, updater: (value: Decimal) => Numerus): void {
    for (const obj of objects) {
      if (typeof obj !== "object" || obj === null) continue;
      const rec = obj as Record<string, Numerus>;
      const currentValue = rec[key];
      if (currentValue == null) continue;
      const newValue = updater(N(currentValue));
      // An addon whose `apply` returns a live Decimal instance must never
      // leave one in state: state always holds the raw Numerus form.
      rec[key] = newValue instanceof Decimal ? NR(newValue) : newValue;
    }
  }

  addPersecDelta(_state: GameState, thing: Producer | Currency, delta: Numerus): void {
    this.fire("before", { type: "addPersecDelta", target: thing, value: delta });
    thing.persecDelta = NR(N(thing.persecDelta ?? 0).add(N(delta)));
    this.fire("after", { type: "addPersecDelta", target: thing, value: delta });
  }

  setPersecDelta(_state: GameState, thing: Producer | Currency, value: Numerus | undefined): void {
    this.fire("before", { type: "setPersecDelta", target: thing, value });
    thing.persecDelta = value;
    this.fire("after", { type: "setPersecDelta", target: thing, value });
  }

  incrementAmount(_state: GameState, thing: Producer | Currency, delta: Numerus): void {
    this.fire("before", { type: "incrementAmount", target: thing, value: delta });
    thing.amount = NR(N(thing.amount).add(N(delta)));
    this.fire("after", { type: "incrementAmount", target: thing, value: delta });
  }

  resetForPrestige(state: GameState, prestigeCode: string): void {
    this.fire("before", { type: "resetForPrestige", value: prestigeCode });
    for (const thing of this.getAllThings(state)) {
      if (thing.resetsOn?.includes(prestigeCode)) {
        thing.amount = thing.resetsTo ? NR(thing.resetsTo) : ZERO;
        if ("bought" in thing) thing.bought = ZERO;
        if ("persec" in thing) thing.persec = ZERO;
      }
    }
    this.fire("after", { type: "resetForPrestige", value: prestigeCode });
  }
}

export class DefaultEffectResolver implements EffectResolver {
  private accessorCache = new Map<string, CompiledAccessor>();
  private keyFor(target: Target): string {
    return `${target.kind}:${target.code}:${target.path}`;
  }

  apply(state: GameState, effect: Effect, amount: Numerus, services: EngineServices): void {
    const value = computeGrowthFunction(effect.func, amount, services.growths);
    const key = this.keyFor(effect.target);
    let accessor = this.accessorCache.get(key);
    if (!accessor) {
      accessor = services.registry.getAccessor(effect.target);
      this.accessorCache.set(key, accessor);
    }
    const resolved = accessor.resolve(state);
    if (!resolved) return;

    const effectDef = services.effectTypes.lookup(effect.type);
    if (!effectDef) {
      services.logger.error(`Effect type not found: "${effect.type}". Skipping effect.`);
      return;
    }

    if (effectDef.allowedStages && !effectDef.allowedStages.includes(effect.stage)) {
      services.logger.warn(`Effect type "${effect.type}" used in stage ${effect.stage}, but allowedStages is [${effectDef.allowedStages.join(", ")}]. Applying anyway.`);
    }

    const updater = (previous: Decimal) => effectDef.apply(previous, value);
    services.adapter.setValues(state, resolved.objects, resolved.key, updater);
  }
}

/** Indexes producers, currencies and upgrades by code, rebuilding on array reference/size changes. */
export class DefaultEntityRegistry implements EntityRegistry {
  private producers = new Map<string, Producer>();
  private currencies = new Map<string, Currency>();
  private upgrades = new Map<string, Upgrade>();
  private sizes: { p: number; c: number; u: number } = { p: -1, c: -1, u: -1 };
  private refs: { p: Producer[] | null; c: Currency[] | null; u: Upgrade[] | null } = { p: null, c: null, u: null };

  refresh(state: GameState): void {
    if (this.sizes.p !== state.producers.length || this.refs.p !== state.producers) {
      this.producers.clear();
      for (const p of state.producers) this.producers.set(p.code, p);
      this.sizes.p = state.producers.length;
      this.refs.p = state.producers;
    }
    if (this.sizes.c !== state.currencies.length || this.refs.c !== state.currencies) {
      this.currencies.clear();
      for (const c of state.currencies) this.currencies.set(c.code, c);
      this.sizes.c = state.currencies.length;
      this.refs.c = state.currencies;
    }
    if (this.sizes.u !== state.upgrades.length || this.refs.u !== state.upgrades) {
      this.upgrades.clear();
      for (const u of state.upgrades) this.upgrades.set(u.code, u);
      this.sizes.u = state.upgrades.length;
      this.refs.u = state.upgrades;
    }
  }

  getByCode(state: GameState, kind: "producer" | "currency" | "upgrade", code: string): Producer | Currency | Upgrade | undefined {
    this.refresh(state);
    if (kind === "producer") return this.producers.get(code);
    if (kind === "currency") return this.currencies.get(code);
    return this.upgrades.get(code);
  }

  findGrowableByCode(state: GameState, code: string): Producer | Currency | undefined {
    this.refresh(state);
    return this.producers.get(code) ?? this.currencies.get(code);
  }

  getAllGrowables(state: GameState): (Producer | Currency)[] {
    this.refresh(state);
    return [...this.producers.values(), ...this.currencies.values()];
  }

  getAccessor(target: Target): CompiledAccessor {
    const segments = target.path.split(".");
    const lastKey = segments[segments.length - 1] ?? "";
    const midSegments = segments.slice(0, Math.max(segments.length - 1, 0));
    const kind = target.kind;
    const code = target.code;

    const resolve = (state: GameState): { objects: unknown[]; key: string } | undefined => {
      this.refresh(state);
      const root = this.getByCode(state, kind, code) as unknown;
      if (!root) return undefined;

      let current: unknown[] = [root];
      for (const step of midSegments) {
        const next: unknown[] = [];
        for (const obj of current) {
          if (step === "*") {
            if (Array.isArray(obj)) {
              for (const it of obj) next.push(it);
            }
          } else if (/^\d+$/.test(step)) {
            const idx = Number(step);
            if (Array.isArray(obj) && idx >= 0 && idx < obj.length) {
              next.push(obj[idx]);
            }
          } else if (typeof obj === "object" && obj !== null) {
            const v = (obj as Record<string, unknown>)[step];
            if (typeof v !== "undefined") next.push(v);
          }
        }
        current = next;
        if (current.length === 0) return undefined;
      }
      return { objects: current, key: lastKey };
    };

    return { resolve };
  }
}

export const consoleLogger = {
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};

export const silentLogger = {
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
};
