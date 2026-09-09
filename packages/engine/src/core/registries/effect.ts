import { type Decimal, NR, type Numerus } from "../../nums";

/** An effect type: how an effect's computed value combines with the target's current value. */
export interface EffectTypeDef {
  /** Unique id, referenced by `Effect.type`. */
  id: string;

  /** Semantic version of the definition. */
  version: string;

  /**
   * Order among effects applied to the same target in the same stage: lower
   * first. Built-ins: `add` 100, `mult` 200.
   */
  priority: number;

  /** Combines the target's current value with the effect's computed value. */
  apply: (prev: Decimal, computed: Decimal) => Numerus;

  /**
   * Stages this type may be used in. Undefined means every stage. A mismatch
   * is logged and the effect is applied anyway.
   */
  allowedStages?: (0 | 1 | 2)[];
}

/** Effect types available to one engine. Seeded with `add` and `mult` unless told otherwise. */
export class EffectRegistry {
  private readonly types = new Map<string, EffectTypeDef>();

  constructor(seedBuiltIns = true) {
    if (seedBuiltIns) {
      for (const def of BUILT_IN_EFFECTS) this.types.set(def.id, def);
    }
  }

  /** Registers a type. An existing id is replaced. */
  register(def: EffectTypeDef): void {
    if (!def.id || !/^[a-z][a-z0-9_]*$/i.test(def.id)) {
      throw new Error(`Invalid effect type id: "${def.id}". Must be alphanumeric and start with a letter.`);
    }
    this.types.set(def.id, def);
  }

  lookup(id: string): EffectTypeDef | undefined {
    return this.types.get(id);
  }

  /** Types sorted by priority, optionally only those allowed in `stage`. */
  list(stage?: 0 | 1 | 2): EffectTypeDef[] {
    let types = Array.from(this.types.values());
    if (stage !== undefined) {
      types = types.filter((t) => !t.allowedStages || t.allowedStages.includes(stage));
    }
    return types.sort((a, b) => a.priority - b.priority);
  }

  /** Removes a type. Returns false when it was not registered. */
  unregister(id: string): boolean {
    return this.types.delete(id);
  }
}

export const BUILT_IN_EFFECTS: readonly EffectTypeDef[] = [
  {
    id: "add",
    version: "1.0.0",
    priority: 100,
    apply: (prev: Decimal, computed: Decimal) => NR(prev.add(computed)),
  },
  {
    id: "mult",
    version: "1.0.0",
    priority: 200,
    apply: (prev: Decimal, computed: Decimal) => NR(prev.mul(computed)),
  },
];
