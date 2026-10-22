import { beforeEach, describe, expect, it, vi } from "vitest";

import { silentLogger } from "../core/di/defaults";
import { Engine } from "../core/engine";
import type { Currency, Prestige, Producer, Upgrade } from "../models/base";
import { ScaleOn, ScalingMethod } from "../models/base";
import { NR } from "../nums";
import { createInitialState } from "../state";
import type { GameState } from "../state";
import { MockTimeProvider } from "../testing/MockTimeProvider";
import { GreedyBot } from "./greedy-bot";
import { horizonValueOfUpgrade } from "./horizon-value";
import { isWaiting } from "./impact";
import type { BotContext } from "./types";

const rate = vi.hoisted(() => ({ fires: false }));

vi.mock("../core/prestige-run", async (importActual) => ({
  ...(await importActual<typeof import("../core/prestige-run")>()),
  rateRulePrestige: () => rate.fires,
}));

const linear = (base: number, coeff: number) => ({ base: NR(base), coeff: NR(coeff), func: ScalingMethod.Linear, scaleOn: ScaleOn.self });

const state = (overrides: Partial<GameState>): GameState => ({ ...createInitialState(), ...overrides });
const engine = () => new Engine(250, { time: new MockTimeProvider(250), logger: silentLogger });
const ctx = (s: GameState, tSimMs = 0): BotContext => ({ state: s, engine: engine(), tSimMs });

const currency = (code: string, amount: number, persecDelta?: number): Currency => ({
  code,
  name: code,
  primary: code === "primary",
  amount: NR(amount),
  persecDelta: persecDelta === undefined ? undefined : NR(persecDelta),
});

const producer = (code: string, cost: number, currencyCode = "primary", target = "primary", persec = 1): Producer => ({
  code,
  name: code,
  currencyCode,
  amount: NR(0),
  bought: NR(0),
  produces: [{ code: target, persec: NR(persec) }],
  scaling: linear(cost, 0),
});

const shopUpgrade = (code: string, cost: number, extra: Partial<Upgrade> = {}): Upgrade => ({
  code,
  name: code,
  currencyCode: "if",
  amount: NR(0),
  bought: NR(0),
  max: NR(1),
  scaling: linear(cost, 0),
  effects: [],
  ...extra,
});

const prestige = (code: string, currencyCode: string, effects: Prestige["effects"] = []): Prestige => ({
  code,
  currencyCode,
  source: { kind: "currency", code: "primary", path: "amount" },
  target: { kind: "currency", code: currencyCode, path: "amount" },
  func: linear(0, 1),
  effects,
});

const bigEffect = (): Prestige["effects"] => [{ stage: 0, target: { kind: "currency", code: "primary", path: "persecDelta" }, type: "mult", func: linear(1, 0.01) }];

describe("prestigeRules", () => {
  const rich = (prestiges: Prestige[], extra: Partial<GameState> = {}) =>
    state({ currencies: [currency("primary", 1000, 10), currency("if", 10), currency("cocoon", 0)], prestiges, ...extra });

  beforeEach(() => {
    rate.fires = false;
  });

  it("absent code keeps the ratio behaviour; explicit ratio is identical", () => {
    const s = rich([prestige("fragmentation", "if", bigEffect())]);
    const expected = [{ kind: "prestige", code: "fragmentation" }];
    expect(new GreedyBot().decide(ctx(s))).toEqual(expected);
    expect(new GreedyBot({ prestigeRules: { fragmentation: "ratio" } }).decide(ctx(s))).toEqual(expected);
  });

  it("minGain prestiges when the delivered gain reaches it (and only then)", () => {
    const s = rich([prestige("fragmentation", "if")]); // no effects: ratio never fires
    expect(new GreedyBot().decide(ctx(s))).toEqual([]);
    expect(new GreedyBot({ prestigeRules: { fragmentation: { minGain: 1000 } } }).decide(ctx(s))).toEqual([{ kind: "prestige", code: "fragmentation" }]);
    expect(new GreedyBot({ prestigeRules: { fragmentation: { minGain: 1001 } } }).decide(ctx(s))).toEqual([]);
  });

  it("rate delegates to the core rateRulePrestige", () => {
    const s = rich([prestige("fragmentation", "if", bigEffect())]);
    const bot = new GreedyBot({ prestigeRules: { fragmentation: "rate" } });
    expect(bot.decide(ctx(s))).toEqual([]); // ratio would fire, but the rule is "rate" and it says no
    rate.fires = true;
    expect(bot.decide(ctx(s))).toEqual([{ kind: "prestige", code: "fragmentation" }]);
  });

  it("rules are per prestige code", () => {
    const s = rich([prestige("fragmentation", "if"), prestige("compression", "cocoon")]);
    const bot = new GreedyBot({ prestigeRules: { compression: { minGain: 1 } } });
    expect(bot.decide(ctx(s))).toEqual([{ kind: "prestige", code: "compression" }]);
    const other = new GreedyBot({ prestigeRules: { fragmentation: { minGain: 1 }, compression: { minGain: 1e9 } } });
    expect(other.decide(ctx(s))).toEqual([{ kind: "prestige", code: "fragmentation" }]);
  });

  it("anti-stall applies only to codes without an explicit rule", () => {
    const stalled = (rules: Record<string, { minGain: number }>) => {
      const bot = new GreedyBot({ stallPrestigeAfterMs: 1000, prestigeRules: rules });
      bot.decide(ctx(rich([prestige("fragmentation", "if")]), 0));
      return bot.decide(ctx(rich([prestige("fragmentation", "if")]), 5000));
    };
    expect(stalled({})).toEqual([{ kind: "prestige", code: "fragmentation" }]);
    expect(stalled({ fragmentation: { minGain: 1e9 } })).toEqual([]);
  });

  it("the waiting metric honours the rules", () => {
    const s = rich([prestige("fragmentation", "if")]);
    const opts = { minImpact: 0.01, horizonMs: 600_000, prestigeRatio: 1.5 };
    expect(isWaiting(engine(), s, opts)).toBe(true);
    expect(isWaiting(engine(), s, { ...opts, prestigeRules: { fragmentation: { minGain: 1 } } })).toBe(false);
  });

  it("rejects malformed rules", () => {
    // @ts-expect-error invalid on purpose
    expect(() => new GreedyBot({ prestigeRules: { x: "often" } })).toThrow(/prestigeRules/);
    expect(() => new GreedyBot({ prestigeRules: { x: { minGain: Number.NaN } } })).toThrow(/prestigeRules/);
  });
});

describe("shopPriority", () => {
  const base = (ifAmount: number, upgrades: Upgrade[], extra: Partial<GameState> = {}) =>
    state({ currencies: [currency("primary", 0, 10), currency("if", ifAmount)], prestiges: [prestige("fragmentation", "if")], upgrades, ...extra });
  const buys = (...codes: string[]) => codes.map((code) => ({ kind: "buyUpgrade", code }));

  it("buys the first listed entry that is affordable, repeating down the list", () => {
    const s = base(100, [shopUpgrade("a", 50), shopUpgrade("b", 20), shopUpgrade("c", 5)]);
    expect(new GreedyBot({ shopPriority: ["upgrade:a", "upgrade:b", "upgrade:c"] }).decide(ctx(s))).toEqual(buys("a", "b", "c"));
  });

  it("saves for the target: nothing is bought when no later entry is a crumb", () => {
    const s = base(100, [shopUpgrade("a", 200), shopUpgrade("b", 30)]);
    expect(new GreedyBot({ shopPriority: ["upgrade:a", "upgrade:b"] }).decide(ctx(s))).toEqual([]);
  });

  it("buys crumbs (<= crumbFraction x target price) under the cumulative cap, in list order", () => {
    // target a costs 200 -> crumb limit 20; balance 100 -> cap 10.
    const upgrades = [shopUpgrade("a", 200), shopUpgrade("b", 5), shopUpgrade("c", 3), shopUpgrade("e", 4), shopUpgrade("big", 30), shopUpgrade("unlisted", 1)];
    const s = base(100, upgrades);
    const bot = new GreedyBot({ shopPriority: ["upgrade:a", "upgrade:b", "upgrade:big", "upgrade:c", "upgrade:e"] });
    // b (5) + c (3) = 8 <= 10; e (4) would make 12 > 10; big (30) is above the crumb limit.
    expect(bot.decide(ctx(s))).toEqual(buys("b", "c"));
  });

  it("crumbFraction is configurable", () => {
    const s = base(100, [shopUpgrade("a", 200), shopUpgrade("b", 30)]);
    expect(new GreedyBot({ shopPriority: ["upgrade:a", "upgrade:b"], crumbFraction: 0.2 }).decide(ctx(s))).toEqual([]); // limit 40 ok, cap 20 < 30
    expect(new GreedyBot({ shopPriority: ["upgrade:a", "upgrade:b"], crumbFraction: 0.5 }).decide(ctx(s))).toEqual(buys("b")); // limit 100, cap 50
  });

  it("never buys entries that are not in the list", () => {
    const s = base(1000, [shopUpgrade("a", 10), shopUpgrade("other", 1)]);
    expect(new GreedyBot({ shopPriority: ["upgrade:a"] }).decide(ctx(s))).toEqual(buys("a"));
  });

  it("skips maxed and locked entries when choosing the target", () => {
    const locked = shopUpgrade("locked", 10, { unlock: { kind: "currency", code: "primary", field: "amount", gt: NR(1e9) } });
    const maxed = shopUpgrade("maxed", 10, { bought: NR(1), amount: NR(1) });
    const s = base(100, [locked, maxed, shopUpgrade("next", 40)]);
    expect(new GreedyBot({ shopPriority: ["upgrade:locked", "upgrade:maxed", "upgrade:next"] }).decide(ctx(s))).toEqual(buys("next"));
  });

  it("removes a production upgrade paid in a prestige currency from the main pass", () => {
    const producing = shopUpgrade("prod", 10, { effects: [{ stage: 0, target: { kind: "currency", code: "primary", path: "persecDelta" }, type: "mult", func: linear(1, 1) }] });
    const s = base(100, [producing]);
    expect(new GreedyBot().decide(ctx(s))).toEqual(buys("prod")); // today: bought by the main pass
    expect(new GreedyBot({ shopPriority: [] }).decide(ctx(s))).toEqual([]); // policy owns it, and it is not listed
    expect(new GreedyBot({ shopPriority: ["upgrade:prod"] }).decide(ctx(s))).toEqual(buys("prod"));
  });

  it("a utility upgrade is left to the policy too", () => {
    const util = shopUpgrade("util", 10, { max: undefined });
    const s = base(25, [util]);
    expect(new GreedyBot().decide(ctx(s))).toEqual(buys("util", "util"));
    expect(new GreedyBot({ shopPriority: [] }).decide(ctx(s))).toEqual([]);
  });

  it("buys producers paid in a prestige currency, with their own offsets", () => {
    const flies = producer("fly", 10, "if", "primary", 1);
    flies.scaling = linear(10, 0);
    const s = base(25, [], { producers: [flies] });
    expect(new GreedyBot({ shopPriority: ["producer:fly"] }).decide(ctx(s))).toEqual([
      { kind: "buyProducer", code: "fly", amount: 1 },
      { kind: "buyProducer", code: "fly", amount: 1 },
    ]);
    expect(new GreedyBot({ shopPriority: [] }).decide(ctx(s))).toEqual([]);
  });

  it("keeps one target per cost currency", () => {
    const cocoonUp = shopUpgrade("t", 5, { currencyCode: "cocoon" });
    const s = state({
      currencies: [currency("primary", 0, 10), currency("if", 100), currency("cocoon", 5)],
      prestiges: [prestige("fragmentation", "if"), prestige("compression", "cocoon")],
      upgrades: [shopUpgrade("a", 500), cocoonUp],
    });
    // "a" is the IF target (unaffordable), but the cocoon list is separate: "t" is its own target and affordable.
    expect(new GreedyBot({ shopPriority: ["upgrade:a", "upgrade:t"] }).decide(ctx(s))).toEqual(buys("t"));
  });

  it("does not touch purchases paid in non-prestige currencies", () => {
    const s = base(0, [], { currencies: [currency("primary", 100, 10), currency("if", 0)], producers: [producer("p", 10)] });
    expect(new GreedyBot({ shopPriority: [] }).decide(ctx(s)).length).toBeGreaterThan(0);
  });

  it("drops the shop from the ratio's shop factor", () => {
    const boost = shopUpgrade("boost", 10, {
      max: NR(5),
      effects: [{ stage: 0, target: { kind: "currency", code: "primary", path: "persecDelta" }, type: "mult", func: linear(1, 1) }],
    });
    const s = base(0, [boost], { currencies: [currency("primary", 1000, 10), currency("if", 0)] });
    // The prestige has no effect of its own: only the levels its gain could buy lift m'/m.
    expect(new GreedyBot({ prestigeRatio: 1.5 }).decide(ctx(s))).toEqual([{ kind: "prestige", code: "fragmentation" }]);
    expect(new GreedyBot({ prestigeRatio: 1.5, shopPriority: [] }).decide(ctx(s))).toEqual([]);
  });

  it("validates its inputs and can be switched off with null", () => {
    // @ts-expect-error invalid on purpose
    expect(() => new GreedyBot({ shopPriority: ["a"] })).toThrow(/shopPriority/);
    expect(() => new GreedyBot({ crumbFraction: -1 })).toThrow(/crumbFraction/);
    const s = base(100, [shopUpgrade("util", 10, { max: undefined })]);
    const bot = new GreedyBot({ shopPriority: [] });
    expect(bot.decide(ctx(s))).toEqual([]);
    bot.setOptions({ shopPriority: null });
    expect(bot.decide(ctx(s)).length).toBeGreaterThan(0);
  });
});

describe("ignoreUnownedTargets and select", () => {
  const withTarget = (target: Upgrade["effects"][number]["target"]): Upgrade => ({
    ...shopUpgrade("boost", 10, { currencyCode: "primary", max: undefined }),
    effects: [{ stage: 0, target, type: "mult", func: linear(1, 1) }],
  });
  const path = "produces.*.persec" as const;
  const p1 = producer("p1", 10); // reaches primary
  const p2 = producer("p2", 10, "primary", "dead"); // dead-end chain
  const world = (owned: { p1?: number; p2?: number }) =>
    state({
      currencies: [currency("primary", 0, 10), currency("dead", 0)],
      producers: [
        { ...p1, amount: NR(owned.p1 ?? 0) },
        { ...p2, amount: NR(owned.p2 ?? 0) },
      ],
    });
  const value = (s: GameState, up: Upgrade, ignoreUnownedTargets?: boolean) => horizonValueOfUpgrade(engine(), s, up, 600_000, { ignoreUnownedTargets });

  it("default values an effect on a producer that is not owned", () => {
    expect(value(world({}), withTarget({ kind: "producer", code: "p1", path })).gt(0)).toBe(true);
  });

  it("ignoreUnownedTargets values it 0, and keeps the value once owned", () => {
    const up = withTarget({ kind: "producer", code: "p1", path });
    expect(value(world({}), up, true).eq(0)).toBe(true);
    expect(value(world({ p1: 3 }), up, true).gt(0)).toBe(true);
  });

  it("resolves a select target to the highest owned tier before valuing", () => {
    const select = withTarget({ kind: "producer", code: "p1", path, select: { highestOwnedOf: ["p1", "p2"] } });
    expect(value(world({ p1: 2, p2: 2 }), select).eq(0)).toBe(true); // resolves to p2: a dead-end chain
    expect(value(world({ p1: 2 }), select).gt(0)).toBe(true); // resolves to p1
    expect(value(world({}), select).gt(0)).toBe(true); // nothing owned: falls back to the declared code
    expect(value(world({}), select, true).eq(0)).toBe(true); // ... unless unowned targets are ignored
  });

  it("the bot passes the option through to its valuation", () => {
    const up = withTarget({ kind: "producer", code: "p1", path });
    const s = { ...world({}), currencies: [currency("primary", 100, 10), currency("dead", 0)], upgrades: [up] };
    expect(new GreedyBot().decide(ctx(s)).some((i) => i.kind === "buyUpgrade")).toBe(true);
    expect(new GreedyBot({ ignoreUnownedTargets: true }).decide(ctx(s)).some((i) => i.kind === "buyUpgrade")).toBe(false);
  });
});
