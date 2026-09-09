import { describe, expect, it } from "vitest";

import { TICK_MS_INTERVAL } from "../constants";
import type { Currency, GrowthFunction, Prestige, Producer, Upgrade } from "../models/base";
import { ScaleOn, ScalingMethod } from "../models/base";
import { N, NR } from "../nums";
import { type GameState, createInitialState } from "../state";
import { activeBehaviors, applyPrestigeDrips, keptLevelsFraction, runAutoPrestiges, runUpgradeAutobuyers } from "./behaviors";
import { Engine } from "./engine";

/** F(C) = C: the prestige gain equals the source value verbatim. */
const IDENTITY: GrowthFunction = { base: NR(0), coeff: NR(1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self };

function makeRunUpgrade(code: string, opts: { resetsOn?: string[]; currencyCode?: string; max?: number } = {}): Upgrade {
  return {
    code,
    name: code,
    currencyCode: opts.currencyCode ?? "one",
    amount: NR(0),
    bought: NR(0),
    max: opts.max !== undefined ? NR(opts.max) : undefined,
    scaling: { base: NR(1), coeff: NR(1), func: ScalingMethod.Linear, scaleOn: ScaleOn.self },
    effects: [],
    resetsOn: opts.resetsOn ?? ["reset"],
  };
}

function makePrestige(): Prestige {
  return {
    code: "reset",
    currencyCode: "if",
    source: { kind: "currency", code: "one", path: "amount" },
    target: { kind: "currency", code: "if", path: "amount" },
    func: IDENTITY,
    effects: [],
  };
}

describe("activeBehaviors", () => {
  it("collects behaviors of the given kind from bought upgrades, in declaration order", () => {
    const state: GameState = {
      ...createInitialState(),
      upgrades: [
        { ...makeRunUpgrade("u1"), bought: NR(1), behaviors: [{ kind: "autobuyUpgrades" }] },
        { ...makeRunUpgrade("u2"), bought: NR(0), behaviors: [{ kind: "autobuyUpgrades" }] },
        { ...makeRunUpgrade("u3"), bought: NR(1), behaviors: [{ kind: "keepLevels", prestigeCode: "reset", fraction: 0.5 }] },
      ],
    };

    const result = activeBehaviors(state, "autobuyUpgrades");
    expect(result).toHaveLength(1);
    expect(result[0]?.upgrade.code).toBe("u1");
  });
});

describe("runUpgradeAutobuyers", () => {
  it("buys one level of every upgrade resetting on the given prestigeCode", () => {
    const state: GameState = {
      ...createInitialState(),
      currencies: [{ code: "one", name: "one", amount: NR(1000) }],
      upgrades: [
        { ...makeRunUpgrade("owner"), bought: NR(1), behaviors: [{ kind: "autobuyUpgrades", prestigeCode: "reset" }] },
        makeRunUpgrade("run-a", { resetsOn: ["reset"] }),
        makeRunUpgrade("run-b", { resetsOn: [] }), // not reset by reset: untouched
      ],
      prestiges: [makePrestige()],
    };
    const engine = new Engine();

    runUpgradeAutobuyers(engine, state);

    expect(N(state.upgrades[1]!.bought).toNumber()).toBe(1);
    expect(N(state.upgrades[2]!.bought).toNumber()).toBe(0);
  });

  it("buys every upgrade with a non-empty resetsOn when prestigeCode is absent", () => {
    const state: GameState = {
      ...createInitialState(),
      currencies: [{ code: "one", name: "one", amount: NR(1000) }],
      upgrades: [
        { ...makeRunUpgrade("owner"), bought: NR(1), behaviors: [{ kind: "autobuyUpgrades" }] },
        makeRunUpgrade("run-a", { resetsOn: ["reset"] }),
        makeRunUpgrade("run-b", { resetsOn: ["another"] }),
      ],
    };
    const engine = new Engine();

    runUpgradeAutobuyers(engine, state);

    expect(N(state.upgrades[1]!.bought).toNumber()).toBe(1);
    expect(N(state.upgrades[2]!.bought).toNumber()).toBe(1);
  });

  it("is a no-op when prestigeCode names an unknown prestige", () => {
    const state: GameState = {
      ...createInitialState(),
      currencies: [{ code: "one", name: "one", amount: NR(1000) }],
      upgrades: [
        { ...makeRunUpgrade("owner"), bought: NR(1), behaviors: [{ kind: "autobuyUpgrades", prestigeCode: "missing" }] },
        makeRunUpgrade("run-a", { resetsOn: ["reset"] }),
      ],
    };
    const engine = new Engine();

    runUpgradeAutobuyers(engine, state);

    expect(N(state.upgrades[1]!.bought).toNumber()).toBe(0);
  });

  it("respects an upgrade's max", () => {
    const state: GameState = {
      ...createInitialState(),
      currencies: [{ code: "one", name: "one", amount: NR(1000) }],
      upgrades: [
        { ...makeRunUpgrade("owner"), bought: NR(1), behaviors: [{ kind: "autobuyUpgrades" }] },
        { ...makeRunUpgrade("run-a", { resetsOn: ["reset"], max: 0 }), amount: NR(0) },
      ],
    };
    const engine = new Engine();

    runUpgradeAutobuyers(engine, state);

    expect(N(state.upgrades[1]!.bought).toNumber()).toBe(0);
  });
});

describe("applyPrestigeDrips", () => {
  function makeDripState(ratePerSecond: number, level: number): GameState {
    return {
      ...createInitialState(),
      currencies: [
        { code: "one", name: "one", amount: NR(1e6) },
        { code: "if", name: "if", amount: NR(0), earned: NR(0) },
      ],
      prestiges: [makePrestige()],
      upgrades: [{ ...makeRunUpgrade("owner", { currencyCode: "if" }), bought: NR(level), behaviors: [{ kind: "prestigeDrip", prestigeCode: "reset", ratePerSecond }] }],
    };
  }

  it("is a no-op at elapsed 0", () => {
    const state = makeDripState(0.1, 1);
    const engine = new Engine();

    applyPrestigeDrips(engine, state, 0);

    const currency = state.currencies.find((c) => c.code === "if")!;
    expect(N(currency.amount).toNumber()).toBe(0);
    expect(N(currency.earned ?? 0).toNumber()).toBe(0);
  });

  it("grows both amount and earned at elapsed > 0, folding gainMult", () => {
    const state = makeDripState(0.1, 2);
    const currency = state.currencies.find((c) => c.code === "if")!;
    currency.gainMult = NR(2);
    const engine = new Engine();

    applyPrestigeDrips(engine, state, 1000); // 1s: rate 0.1 * level 2 * 1s = 0.2 of the pending gain

    // Pending gain: floor(one.amount(1e6) * gainMult(2)) = 2_000_000
    // drip = gain * 0.2 = 400_000
    expect(N(currency.amount).toNumber()).toBeCloseTo(400000, 6);
    expect(N(currency.earned ?? 0).toNumber()).toBeCloseTo(400000, 6);
  });

  it("is a no-op when prestigeCode names an unknown prestige", () => {
    const state = makeDripState(0.1, 1);
    state.prestiges = [];
    const engine = new Engine();

    applyPrestigeDrips(engine, state, 1000);

    const currency = state.currencies.find((c) => c.code === "if")!;
    expect(N(currency.amount).toNumber()).toBe(0);
  });
});

describe("runAutoPrestiges", () => {
  function makeAutoPrestigeState(ratio: number, earned?: number): GameState {
    return {
      ...createInitialState(),
      currencies: [
        { code: "one", name: "one", amount: NR(1e6) },
        { code: "if", name: "if", amount: NR(0), earned: earned !== undefined ? NR(earned) : undefined },
      ],
      prestiges: [makePrestige()],
      upgrades: [{ ...makeRunUpgrade("owner", { currencyCode: "if" }), bought: NR(1), behaviors: [{ kind: "autoPrestige", prestigeCode: "reset", ratio }] }],
    };
  }

  it("fires at the first whole unit when nothing was earned yet", () => {
    const state = makeAutoPrestigeState(1.5);
    const engine = new Engine();

    runAutoPrestiges(engine, state);

    const currency = state.currencies.find((c) => c.code === "if")!;
    expect(N(currency.earned ?? 0).gt(0)).toBe(true);
  });

  it("does not fire below the ratio", () => {
    // Pending gain: floor(1e6) = 1_000_000. earned 900_000 -> ratio (900000+1000000)/900000 ≈ 2.11 >= 1.5... use a lower gain instead.
    const state = makeAutoPrestigeState(10, 1_000_000);
    const engine = new Engine();

    runAutoPrestiges(engine, state);

    const currency = state.currencies.find((c) => c.code === "if")!;
    // gain(1e6) added to earned(1e6): ratio = 2 < 10 -> must not fire.
    expect(N(currency.earned ?? 0).toNumber()).toBe(1_000_000);
  });

  it("fires once the ratio is reached", () => {
    const state = makeAutoPrestigeState(2, 1_000_000);
    const engine = new Engine();

    runAutoPrestiges(engine, state);

    const currency = state.currencies.find((c) => c.code === "if")!;
    // gain(1e6) added to earned(1e6): ratio = 2 >= 2 -> fires.
    expect(N(currency.earned ?? 0).toNumber()).toBe(2_000_000);
  });

  it("is a no-op when prestigeCode names an unknown prestige", () => {
    const state = makeAutoPrestigeState(1.5);
    state.prestiges = [];
    const engine = new Engine();

    runAutoPrestiges(engine, state);

    const currency = state.currencies.find((c) => c.code === "if")!;
    expect(N(currency.earned ?? 0).toNumber()).toBe(0);
  });
});

describe("keptLevelsFraction", () => {
  it("returns 0 without an active keepLevels behavior", () => {
    const state: GameState = { ...createInitialState(), upgrades: [makeRunUpgrade("run-a")] };
    expect(keptLevelsFraction(state, "reset")).toBe(0);
  });

  it("returns the largest fraction among several active behaviors targeting the same prestige", () => {
    const state: GameState = {
      ...createInitialState(),
      upgrades: [
        { ...makeRunUpgrade("owner-a"), bought: NR(1), behaviors: [{ kind: "keepLevels", prestigeCode: "reset", fraction: 0.3 }] },
        { ...makeRunUpgrade("owner-b"), bought: NR(1), behaviors: [{ kind: "keepLevels", prestigeCode: "reset", fraction: 0.5 }] },
      ],
    };
    expect(keptLevelsFraction(state, "reset")).toBe(0.5);
  });
});

describe("Engine.performPrestige — keepLevels integration", () => {
  it("keeps floor(bought * fraction) levels of the reset upgrades, and restores them after head-start grants", () => {
    const producer: Producer = {
      code: "e1",
      name: "e1",
      currencyCode: "one",
      amount: NR(0),
      bought: NR(0),
      produces: [{ code: "one", persec: NR(1) }],
      scaling: { base: NR(10), coeff: NR(1.2), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
      resetsOn: ["reset"],
    };
    const oneCurrency: Currency = { code: "one", name: "one", amount: NR(1e6) };
    const ifCurrency: Currency = { code: "if", name: "if", amount: NR(0), earned: NR(0) };

    const state: GameState = {
      ...createInitialState(),
      producers: [producer],
      currencies: [oneCurrency, ifCurrency],
      prestiges: [makePrestige()],
      upgrades: [
        { ...makeRunUpgrade("keeper"), bought: NR(1), behaviors: [{ kind: "keepLevels", prestigeCode: "reset", fraction: 0.5 }] },
        makeRunUpgrade("run-a", { resetsOn: ["reset"] }),
      ],
    };
    state.upgrades[1]!.bought = NR(7);
    state.upgrades[1]!.amount = NR(7);

    const engine = new Engine();
    const ok = engine.performPrestige(state, state.prestiges[0]!);

    expect(ok).toBe(true);
    expect(N(state.upgrades[1]!.bought).toNumber()).toBe(3); // floor(7 * 0.5)
  });

  it("calls onPrestige for both a host-triggered and an automation-triggered prestige", () => {
    const calls: string[] = [];
    const oneCurrency: Currency = { code: "one", name: "one", amount: NR(1e6) };
    const ifCurrency: Currency = { code: "if", name: "if", amount: NR(0), earned: NR(0) };

    const makeState = (): GameState => ({
      ...createInitialState(),
      currencies: [{ ...oneCurrency }, { ...ifCurrency }],
      prestiges: [makePrestige()],
    });

    const engine = new Engine(TICK_MS_INTERVAL, { onPrestige: (_state, prestige) => calls.push(prestige.code) });

    const hostState = makeState();
    engine.performPrestige(hostState, hostState.prestiges[0]!);

    const autoState = makeState();
    autoState.upgrades = [{ ...makeRunUpgrade("owner", { currencyCode: "if" }), bought: NR(1), behaviors: [{ kind: "autoPrestige", prestigeCode: "reset", ratio: 1.5 }] }];
    runAutoPrestiges(engine, autoState);

    expect(calls).toEqual(["reset", "reset"]);
  });
});
