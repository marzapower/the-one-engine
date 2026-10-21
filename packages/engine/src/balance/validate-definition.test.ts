import { describe, expect, it } from "vitest";

import { GrowthRegistry } from "../core/registries/growth";
import { N, NR } from "../nums";
import { type DefinitionIssue, type DefinitionIssueCode, type DefinitionRange, parseGameDefinition, validateGameDefinition } from "./validate-definition";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const geo = (base: number, coeff: number, extra: Json = {}): Json => ({ base, coeff, func: "geometric", scaleOn: "self", ...extra });
const lin = (base: number, coeff: number, extra: Json = {}): Json => ({ base, coeff, func: "linear", scaleOn: "self", ...extra });

/** A definition that exercises every section and is valid. Tests mutate a deep copy. */
function validDefinition(): Json {
  return {
    meta: { id: "test", name: "Test", version: 1 },
    benchmark: { overflowCurrencyCode: "gems", trackedProducerCode: "p1" },
    rules: {
      saturation: {
        decayExponent: 2,
        overflowCurrencyCode: "gems",
        gate: { currencyCode: "gold", earnedAtLeast: 30 },
        push: { currencyCode: "gold", exponent: 2 },
        drag: { onset: 10, scale: 2, exponent: 2, floor: 0.1 },
        cooling: { halfLifeMs: 1000 },
      },
    },
    currencies: [
      {
        code: "gold",
        name: "Gold",
        primary: true,
        amount: 0,
        earned: 0,
        resetsOn: ["pr"],
        resetsTo: 0,
        gainMult: 1,
        capacityMult: 1,
        coolingMult: 1,
        drive: { unspentWeight: 1, earnedWeight: 0 },
      },
      { code: "gems", name: "Gems", amount: 0 },
    ],
    producers: [
      {
        code: "p1",
        name: "P1",
        currencyCode: "gold",
        scaling: geo(10, 1.5),
        produces: [{ code: "gold", persec: 1 }],
        resetsOn: ["pr"],
        amount: 0,
        resetsTo: 0,
        capacity: { base: 100, factor: 2, decayScale: 3, overflowRate: 0.5 },
      },
      { code: "p2", name: "P2", currencyCode: "gold", scaling: geo(100, 2), produces: [{ code: "p1", persec: 0.1 }], resetsOn: [], max: 10 },
    ],
    upgrades: [
      {
        code: "u1",
        name: "U1",
        currencyCode: "gold",
        scaling: geo(10, 2, { offset: 0 }),
        resetsOn: ["pr"],
        resetsTo: 0,
        effects: [
          { stage: 0, target: { kind: "currency", code: "gold", path: "amount" }, type: "mult", func: lin(1, 0.5) },
          {
            stage: 1,
            source: { kind: "currency", code: "gold", path: "earned" },
            target: { kind: "producer", code: "p1", path: "produces.0.persec" },
            type: "mult",
            func: geo(1, 2),
          },
        ],
        behaviors: [{ kind: "keepLevels", prestigeCode: "pr", fraction: 0.5 }],
      },
      {
        code: "u2",
        name: "U2",
        currencyCode: "p1",
        scaling: lin(5, 0),
        max: 1,
        effects: [],
        behaviors: [{ kind: "prestigeDrip", prestigeCode: "pr", ratePerSecond: 1 }, { kind: "autoPrestige", prestigeCode: "pr", ratio: 2 }, { kind: "autobuyUpgrades" }],
      },
    ],
    prestiges: [
      {
        code: "pr",
        currencyCode: "gems",
        source: { kind: "currency", code: "gold", path: "earned" },
        target: { kind: "currency", code: "gems", path: "amount" },
        effects: [{ stage: 0, target: { kind: "currency", code: "gold", path: "amount" }, type: "add", func: lin(1, 1) }],
        func: { base: 1, coeff: 1, func: "logarithmic", scaleOn: "self" },
      },
    ],
    clickable: { currencyCode: "gold", gain: 1, cooldownMs: 1000 },
  };
}

function mutated(change: (def: Json) => void): Json {
  const def = validDefinition();
  change(def);
  return def;
}

function summary(issues: DefinitionIssue[]): string[] {
  return issues.map((i) => `${i.code} ${i.path.join(".")}`);
}

describe("validateGameDefinition — valid input", () => {
  it("accepts a definition exercising every section", () => {
    expect(validateGameDefinition(validDefinition())).toEqual([]);
  });

  it("accepts a definition with no producers (the engine has no minimum)", () => {
    expect(validateGameDefinition(mutated((d) => (d.producers = []))).filter((i) => i.code === "invalidShape")).toEqual([]);
    expect(
      validateGameDefinition({
        meta: { id: "t", name: "T", version: 1 },
        producers: [],
        currencies: [{ code: "g", name: "G", primary: true, amount: 0 }],
        prestiges: [],
        upgrades: [],
      }),
    ).toEqual([]);
  });

  it("accepts every GenericNumberInput form, including values far beyond Infinity as a JS number", () => {
    const huge = { sign: 1, layer: 8, mag: 1e10 };
    const def = mutated((d) => {
      d.currencies[1].amount = huge;
      d.producers[0].scaling = geo(10, 1.5, { offset: "1e500" });
      d.upgrades[0].scaling = { base: huge, coeff: NR(2), func: "geometric", scaleOn: "self" };
      d.upgrades[0].effects[0].func = lin(N("1e1000") as unknown as number, 1);
    });
    expect(validateGameDefinition(def)).toEqual([]);
  });

  it("does not turn a huge valid value into an out-of-range error", () => {
    const def = mutated((d) => {
      d.currencies[0].gainMult = { sign: 1, layer: 8, mag: 5 };
      d.producers[0].scaling = geo({ sign: 1, layer: 8, mag: 5 } as unknown as number, 3);
    });
    expect(validateGameDefinition(def)).toEqual([]);
  });
});

describe("validateGameDefinition — never throws", () => {
  const inputs: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a string", "definition"],
    ["an array", []],
    ["an empty object", {}],
    ["nested arrays in place of entities", { meta: [], producers: [[]], currencies: [[[]]], prestiges: [[]], upgrades: [[]] }],
    ["null entities", mutated((d) => (d.producers = [null]))],
    ["a bare symbol inside", mutated((d) => (d.currencies[0].name = Symbol("x")))],
  ];

  it.each(inputs)("returns issues for %s", (_label, input) => {
    let issues: DefinitionIssue[] = [];
    expect(() => (issues = validateGameDefinition(input))).not.toThrow();
    expect(issues.length).toBeGreaterThan(0);
  });

  it.each([
    ["a null-prototype object", () => Object.create(null)],
    ["a string", () => "boom"],
  ])("survives a getter throwing %s", (_label, thrown) => {
    const def = validDefinition();
    Object.defineProperty(def, "producers", {
      get() {
        throw thrown();
      },
      enumerable: true,
    });
    const issues = validateGameDefinition(def);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("invalidShape");
  });

  it("survives a throwing getter", () => {
    const def = validDefinition();
    Object.defineProperty(def, "producers", {
      get() {
        throw new Error("boom");
      },
      enumerable: true,
    });
    const issues = validateGameDefinition(def);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("invalidShape");
  });
});

describe("validateGameDefinition — shape and numbers", () => {
  const cases: [string, (d: Json) => void, DefinitionIssueCode, string][] = [
    ["effect without target", (d) => delete d.upgrades[0].effects[0].target, "invalidShape", "upgrades.0.effects.0.target"],
    ["produces not an array", (d) => (d.producers[0].produces = "gold"), "invalidShape", "producers.0.produces"],
    ["null element in produces", (d) => (d.producers[0].produces = [null]), "invalidShape", "producers.0.produces.0"],
    ["null upgrade", (d) => (d.upgrades = [null]), "invalidShape", "upgrades.0"],
    ["unknown scaleOn", (d) => (d.producers[0].scaling.scaleOn = "sideways"), "invalidShape", "producers.0.scaling.scaleOn"],
    ["bad stage", (d) => (d.upgrades[0].effects[0].stage = 7), "invalidShape", "upgrades.0.effects.0.stage"],
    ["bad target kind", (d) => (d.prestiges[0].source.kind = "planet"), "invalidShape", "prestiges.0.source.kind"],
    ["bad target path syntax", (d) => (d.prestiges[0].source.path = "1bad"), "invalidShape", "prestiges.0.source.path"],
    ["unknown behavior kind", (d) => (d.upgrades[1].behaviors[0].kind = "dance"), "invalidShape", "upgrades.1.behaviors.0.kind"],
    ["empty meta.id", (d) => (d.meta.id = ""), "invalidShape", "meta.id"],
    ["missing producer resetsOn", (d) => delete d.producers[0].resetsOn, "invalidShape", "producers.0.resetsOn"],
    ["missing producer currencyCode", (d) => delete d.producers[0].currencyCode, "invalidShape", "producers.0.currencyCode"],
    ["currencies not an array", (d) => (d.currencies = {}), "invalidShape", "currencies"],
    ["Numerus sign 2", (d) => (d.currencies[0].amount = { sign: 2, layer: 0, mag: 1 }), "invalidNumber", "currencies.0.amount"],
    ["Numerus fractional layer", (d) => (d.currencies[0].amount = { sign: 1, layer: 0.5, mag: 1 }), "invalidNumber", "currencies.0.amount"],
    ["Numerus negative layer", (d) => (d.currencies[0].amount = { sign: 1, layer: -1, mag: 1 }), "invalidNumber", "currencies.0.amount"],
    ["Numerus infinite mag", (d) => (d.currencies[0].amount = { sign: 1, layer: 0, mag: Infinity }), "invalidNumber", "currencies.0.amount"],
    ["string abc", (d) => (d.currencies[0].amount = "abc"), "invalidNumber", "currencies.0.amount"],
    ["NaN", (d) => (d.producers[0].scaling.base = NaN), "invalidNumber", "producers.0.scaling.base"],
    ["Infinity", (d) => (d.producers[0].produces[0].persec = Infinity), "invalidNumber", "producers.0.produces.0.persec"],
    ["Infinite string", (d) => (d.producers[0].scaling.coeff = "Infinity"), "invalidNumber", "producers.0.scaling.coeff"],
    ["missing amount", (d) => delete d.currencies[1].amount, "invalidNumber", "currencies.1.amount"],
    ["array as number", (d) => (d.upgrades[0].max = [1]), "invalidNumber", "upgrades.0.max"],
    ["null as number", (d) => (d.currencies[0].gainMult = null), "invalidNumber", "currencies.0.gainMult"],
    ["NaN meta.version", (d) => (d.meta.version = NaN), "invalidNumber", "meta.version"],
    ["Infinite decayScale", (d) => (d.producers[0].capacity.decayScale = Infinity), "invalidNumber", "producers.0.capacity.decayScale"],
    ["Infinite clickable gain", (d) => (d.clickable.gain = Infinity), "invalidNumber", "clickable.gain"],
    ["NaN push exponent", (d) => (d.rules.saturation.push.exponent = NaN), "invalidNumber", "rules.saturation.push.exponent"],
  ];

  it.each(cases)("%s", (_label, change, code, path) => {
    expect(summary(validateGameDefinition(mutated(change)))).toContain(`${code} ${path}`);
  });

  it("reports shape problems alone, without running the rules", () => {
    const issues = validateGameDefinition(mutated((d) => ((d.producers[0].scaling.base = NaN), (d.prestiges[0].source.code = "nowhere"))));
    expect(summary(issues)).toEqual(["invalidNumber producers.0.scaling.base"]);
  });
});

describe("validateGameDefinition — codes and references", () => {
  const cases: [string, (d: Json) => void, DefinitionIssueCode, string][] = [
    ["duplicate producer code", (d) => (d.producers[1].code = "p1"), "duplicateCode", "producers.1.code"],
    ["duplicate currency code", (d) => (d.currencies[1].code = "gold"), "duplicateCode", "currencies.1.code"],
    ["duplicate upgrade code", (d) => (d.upgrades[1].code = "u1"), "duplicateCode", "upgrades.1.code"],
    ["duplicate prestige code", (d) => d.prestiges.push(structuredClone(d.prestiges[0])), "duplicateCode", "prestiges.1.code"],
    ["producer sharing a currency code", (d) => (d.producers[1].code = "gems"), "duplicateCode", "producers.1.code"],
    ["no primary currency", (d) => delete d.currencies[0].primary, "onePrimary", "currencies"],
    ["two primary currencies", (d) => (d.currencies[1].primary = true), "onePrimary", "currencies"],
    ["producer paid in an unknown currency", (d) => (d.producers[0].currencyCode = "nope"), "unknownCostPool", "producers.0.currencyCode"],
    ["producer paid in a producer", (d) => (d.producers[0].currencyCode = "p2"), "unknownCostPool", "producers.0.currencyCode"],
    ["upgrade paid in an unknown pool", (d) => (d.upgrades[0].currencyCode = "nope"), "unknownCostPool", "upgrades.0.currencyCode"],
    ["upgrade paid in an upgrade", (d) => (d.upgrades[0].currencyCode = "u2"), "unknownCostPool", "upgrades.0.currencyCode"],
    ["produces an unknown code", (d) => (d.producers[0].produces[0].code = "nope"), "unknownGrowable", "producers.0.produces.0.code"],
    ["produces itself", (d) => (d.producers[0].produces[0].code = "p1"), "selfProduction", "producers.0.produces.0.code"],
    ["currency resetsOn an unknown prestige", (d) => (d.currencies[0].resetsOn = ["nope"]), "unknownPrestige", "currencies.0.resetsOn.0"],
    ["producer resetsOn an unknown prestige", (d) => (d.producers[0].resetsOn = ["nope"]), "unknownPrestige", "producers.0.resetsOn.0"],
    ["upgrade resetsOn an unknown prestige", (d) => (d.upgrades[0].resetsOn = ["nope"]), "unknownPrestige", "upgrades.0.resetsOn.0"],
    ["behavior on an unknown prestige", (d) => (d.upgrades[1].behaviors[0].prestigeCode = "nope"), "unknownPrestige", "upgrades.1.behaviors.0.prestigeCode"],
    ["effect target: unknown currency", (d) => (d.upgrades[0].effects[0].target.code = "nope"), "unknownCurrency", "upgrades.0.effects.0.target.code"],
    [
      "effect target: unknown producer",
      (d) => ((d.upgrades[0].effects[1].target.code = "nope"), (d.upgrades[0].effects[1].target.kind = "producer")),
      "unknownProducer",
      "upgrades.0.effects.1.target.code",
    ],
    [
      "effect target: unknown upgrade",
      (d) => (d.upgrades[0].effects[0].target = { kind: "upgrade", code: "nope", path: "amount" }),
      "unknownUpgrade",
      "upgrades.0.effects.0.target.code",
    ],
    ["effect target: unresolvable path", (d) => (d.upgrades[0].effects[0].target.path = "a.b.c"), "unresolvablePath", "upgrades.0.effects.0.target.path"],
    ["effect source: unknown currency", (d) => (d.upgrades[0].effects[1].source.code = "nope"), "unknownCurrency", "upgrades.0.effects.1.source.code"],
    ["effect source: unresolvable path", (d) => (d.upgrades[0].effects[1].source.path = "a.b.c"), "unresolvablePath", "upgrades.0.effects.1.source.path"],
    ["prestige effect target: unknown currency", (d) => (d.prestiges[0].effects[0].target.code = "nope"), "unknownCurrency", "prestiges.0.effects.0.target.code"],
    ["prestige source: unknown currency", (d) => (d.prestiges[0].source.code = "nope"), "unknownCurrency", "prestiges.0.source.code"],
    ["prestige source: unresolvable path", (d) => (d.prestiges[0].source.path = "a.b"), "unresolvablePath", "prestiges.0.source.path"],
    ["prestige target: unknown upgrade", (d) => (d.prestiges[0].target = { kind: "upgrade", code: "nope", path: "amount" }), "unknownUpgrade", "prestiges.0.target.code"],
    ["prestige target: unresolvable path", (d) => (d.prestiges[0].target.path = "a.b"), "unresolvablePath", "prestiges.0.target.path"],
    ["prestige in an unknown currency", (d) => (d.prestiges[0].currencyCode = "nope"), "unknownCurrency", "prestiges.0.currencyCode"],
    ["saturation overflow currency", (d) => (d.rules.saturation.overflowCurrencyCode = "nope"), "unknownCurrency", "rules.saturation.overflowCurrencyCode"],
    ["saturation gate currency", (d) => (d.rules.saturation.gate.currencyCode = "nope"), "unknownCurrency", "rules.saturation.gate.currencyCode"],
    ["saturation push currency", (d) => (d.rules.saturation.push.currencyCode = "nope"), "unknownCurrency", "rules.saturation.push.currencyCode"],
    ["benchmark overflow currency", (d) => (d.benchmark.overflowCurrencyCode = "nope"), "unknownCurrency", "benchmark.overflowCurrencyCode"],
    ["benchmark tracked producer", (d) => (d.benchmark.trackedProducerCode = "gold"), "unknownProducer", "benchmark.trackedProducerCode"],
    ["clickable currency", (d) => (d.clickable.currencyCode = "nope"), "unknownCurrency", "clickable.currencyCode"],
    ["unknown growth method", (d) => (d.producers[0].scaling.func = "cubic"), "unknownGrowth", "producers.0.scaling.func"],
    ["unknown effect type", (d) => (d.upgrades[0].effects[0].type = "made_up"), "unknownEffectType", "upgrades.0.effects.0.type"],
  ];

  it.each(cases)("%s", (_label, change, code, path) => {
    expect(summary(validateGameDefinition(mutated(change)))).toContain(`${code} ${path}`);
  });

  it("accepts an upgrade paid in a producer", () => {
    expect(validDefinition().upgrades[1].currencyCode).toBe("p1");
    expect(validateGameDefinition(validDefinition())).toEqual([]);
  });
});

describe("validateGameDefinition — empty references", () => {
  const cases: [string, (d: Json) => void, DefinitionIssueCode, string][] = [
    ["autoPrestige.prestigeCode", (d) => (d.upgrades[1].behaviors[1].prestigeCode = ""), "unknownPrestige", "upgrades.1.behaviors.1.prestigeCode"],
    ["autobuyUpgrades.prestigeCode", (d) => (d.upgrades[1].behaviors[2].prestigeCode = ""), "unknownPrestige", "upgrades.1.behaviors.2.prestigeCode"],
    ["saturation.overflowCurrencyCode", (d) => (d.rules.saturation.overflowCurrencyCode = ""), "unknownCurrency", "rules.saturation.overflowCurrencyCode"],
    ["saturation.gate.currencyCode", (d) => (d.rules.saturation.gate.currencyCode = ""), "unknownCurrency", "rules.saturation.gate.currencyCode"],
    ["saturation.push.currencyCode", (d) => (d.rules.saturation.push.currencyCode = ""), "unknownCurrency", "rules.saturation.push.currencyCode"],
    ["benchmark.overflowCurrencyCode", (d) => (d.benchmark.overflowCurrencyCode = ""), "unknownCurrency", "benchmark.overflowCurrencyCode"],
    ["benchmark.trackedProducerCode", (d) => (d.benchmark.trackedProducerCode = ""), "unknownProducer", "benchmark.trackedProducerCode"],
    ["clickable.currencyCode", (d) => (d.clickable.currencyCode = ""), "unknownCurrency", "clickable.currencyCode"],
    ["effect source code", (d) => (d.upgrades[0].effects[1].source.code = ""), "unknownCurrency", "upgrades.0.effects.1.source.code"],
  ];

  it.each(cases)("%s", (_label, change, code, path) => {
    expect(summary(validateGameDefinition(mutated(change)))).toContain(`${code} ${path}`);
  });
});

describe("validateGameDefinition — intervals", () => {
  const POS: DefinitionRange = { min: 0, minExclusive: true };
  const NONNEG: DefinitionRange = { min: 0 };
  const UNIT: DefinitionRange = { min: 0, max: 1 };

  // [label, change, expected path, expected range]
  const cases: [string, (d: Json) => void, string, DefinitionRange][] = [
    // curves
    ["cost curve base 0", (d) => (d.producers[0].scaling.base = 0), "producers.0.scaling.base", POS],
    ["effect curve base negative", (d) => (d.upgrades[0].effects[0].func.base = -1), "upgrades.0.effects.0.func.base", POS],
    ["prestige curve base 0", (d) => (d.prestiges[0].func.base = 0), "prestiges.0.func.base", POS],
    ["non-linear effect coeff 0", (d) => (d.upgrades[0].effects[1].func.coeff = 0), "upgrades.0.effects.1.func.coeff", POS],
    ["linear effect coeff negative", (d) => (d.upgrades[0].effects[0].func.coeff = -0.1), "upgrades.0.effects.0.func.coeff", NONNEG],
    ["prestige coeff 0 (even linear)", (d) => (d.prestiges[0].func = lin(1, 0)), "prestiges.0.func.coeff", POS],
    ["prestige coeff 0", (d) => (d.prestiges[0].func.coeff = 0), "prestiges.0.func.coeff", POS],
    ["cost offset negative", (d) => (d.producers[0].scaling.offset = -1), "producers.0.scaling.offset", NONNEG],
    ["linear cost coeff 0 on a producer", (d) => (d.producers[0].scaling = lin(5, 0)), "producers.0.scaling.coeff", POS],
    ["linear cost coeff 0 on an upgrade without max", (d) => ((d.upgrades[1].scaling = lin(5, 0)), delete d.upgrades[1].max), "upgrades.1.scaling.coeff", POS],
    ["geometric cost coeff 1", (d) => (d.producers[0].scaling.coeff = 1), "producers.0.scaling.coeff", { min: 1, minExclusive: true }],
    ["geometric cost coeff below 1 (decreasing)", (d) => (d.producers[0].scaling.coeff = 0.9), "producers.0.scaling.coeff", { min: 1, minExclusive: true }],
    [
      "exponential cost base 1",
      (d) => (d.producers[0].scaling = { base: 1, coeff: 2, func: "exponential", scaleOn: "self" }),
      "producers.0.scaling.base",
      { min: 1, minExclusive: true },
    ],
    ["exponential cost coeff 0", (d) => (d.producers[0].scaling = { base: 2, coeff: 0, func: "exponential", scaleOn: "self" }), "producers.0.scaling.coeff", POS],
    [
      "double exponential cost base 1",
      (d) => (d.producers[0].scaling = { base: 1, coeff: 2, func: "double_exponential", scaleOn: "self" }),
      "producers.0.scaling.base",
      { min: 1, minExclusive: true },
    ],
    [
      "double exponential cost coeff 1",
      (d) => (d.producers[0].scaling = { base: 2, coeff: 1, func: "double_exponential", scaleOn: "self" }),
      "producers.0.scaling.coeff",
      { min: 1, minExclusive: true },
    ],
    // currencies
    ["currency amount negative", (d) => (d.currencies[0].amount = -1), "currencies.0.amount", NONNEG],
    ["currency earned negative", (d) => (d.currencies[0].earned = -1), "currencies.0.earned", NONNEG],
    ["currency resetsTo negative", (d) => (d.currencies[0].resetsTo = -1), "currencies.0.resetsTo", NONNEG],
    ["currency gainMult 0", (d) => (d.currencies[0].gainMult = 0), "currencies.0.gainMult", POS],
    ["currency capacityMult 0", (d) => (d.currencies[0].capacityMult = 0), "currencies.0.capacityMult", POS],
    ["currency coolingMult 0", (d) => (d.currencies[0].coolingMult = 0), "currencies.0.coolingMult", POS],
    ["drive.unspentWeight negative", (d) => (d.currencies[0].drive.unspentWeight = -1), "currencies.0.drive.unspentWeight", NONNEG],
    ["drive.earnedWeight negative", (d) => (d.currencies[0].drive.earnedWeight = -1), "currencies.0.drive.earnedWeight", NONNEG],
    // producers
    ["producer amount negative", (d) => (d.producers[0].amount = -1), "producers.0.amount", NONNEG],
    ["producer resetsTo negative", (d) => (d.producers[0].resetsTo = -1), "producers.0.resetsTo", NONNEG],
    ["produces persec 0", (d) => (d.producers[0].produces[0].persec = 0), "producers.0.produces.0.persec", POS],
    ["producer max 0", (d) => (d.producers[1].max = 0), "producers.1.max", POS],
    ["capacity base 0", (d) => (d.producers[0].capacity.base = 0), "producers.0.capacity.base", POS],
    ["capacity factor 0", (d) => (d.producers[0].capacity.factor = 0), "producers.0.capacity.factor", POS],
    ["capacity decayScale 0", (d) => (d.producers[0].capacity.decayScale = 0), "producers.0.capacity.decayScale", POS],
    ["capacity overflowRate negative", (d) => (d.producers[0].capacity.overflowRate = -0.1), "producers.0.capacity.overflowRate", UNIT],
    ["capacity overflowRate above 1", (d) => (d.producers[0].capacity.overflowRate = 1.5), "producers.0.capacity.overflowRate", UNIT],
    // upgrades
    ["upgrade max 0", (d) => (d.upgrades[1].max = 0), "upgrades.1.max", POS],
    ["upgrade resetsTo negative", (d) => (d.upgrades[0].resetsTo = -1), "upgrades.0.resetsTo", NONNEG],
    // behaviors
    ["prestigeDrip ratePerSecond 0", (d) => (d.upgrades[1].behaviors[0].ratePerSecond = 0), "upgrades.1.behaviors.0.ratePerSecond", POS],
    ["autoPrestige ratio 0", (d) => (d.upgrades[1].behaviors[1].ratio = 0), "upgrades.1.behaviors.1.ratio", POS],
    ["keepLevels fraction above 1", (d) => (d.upgrades[0].behaviors[0].fraction = 1.5), "upgrades.0.behaviors.0.fraction", UNIT],
    ["keepLevels fraction negative", (d) => (d.upgrades[0].behaviors[0].fraction = -0.5), "upgrades.0.behaviors.0.fraction", UNIT],
    // saturation
    ["decayExponent 0", (d) => (d.rules.saturation.decayExponent = 0), "rules.saturation.decayExponent", POS],
    ["drag.scale 0", (d) => (d.rules.saturation.drag.scale = 0), "rules.saturation.drag.scale", POS],
    ["drag.exponent 0", (d) => (d.rules.saturation.drag.exponent = 0), "rules.saturation.drag.exponent", POS],
    ["cooling.halfLifeMs 0", (d) => (d.rules.saturation.cooling.halfLifeMs = 0), "rules.saturation.cooling.halfLifeMs", POS],
    ["gate.earnedAtLeast negative", (d) => (d.rules.saturation.gate.earnedAtLeast = -1), "rules.saturation.gate.earnedAtLeast", NONNEG],
    ["drag.onset negative", (d) => (d.rules.saturation.drag.onset = -1), "rules.saturation.drag.onset", NONNEG],
    ["drag.floor above 1", (d) => (d.rules.saturation.drag.floor = 2), "rules.saturation.drag.floor", UNIT],
    // clickable
    ["clickable gain 0", (d) => (d.clickable.gain = 0), "clickable.gain", POS],
    ["clickable cooldown below the floor", (d) => (d.clickable.cooldownMs = 99), "clickable.cooldownMs", { min: 100 }],
  ];

  it.each(cases)("%s", (_label, change, path, range) => {
    const issues = validateGameDefinition(mutated(change));
    const found = issues.find((i) => i.code === "outOfRange" && i.path.join(".") === path);
    expect(found, `issues: ${JSON.stringify(summary(issues))}`).toBeDefined();
    expect(found?.range).toEqual(range);
  });

  it("accepts the boundaries", () => {
    const def = mutated((d) => {
      d.currencies[0].amount = 0;
      d.currencies[0].drive = { unspentWeight: 0, earnedWeight: 0 };
      d.producers[0].capacity.overflowRate = 0;
      d.upgrades[0].behaviors[0].fraction = 1;
      d.rules.saturation.drag.floor = 1;
      d.rules.saturation.drag.onset = 0;
      d.rules.saturation.gate.earnedAtLeast = 0;
      d.clickable.cooldownMs = 100;
      d.producers[0].scaling = lin(5, 1);
      d.upgrades[0].effects[0].func = lin(1, 0);
    });
    expect(validateGameDefinition(def)).toEqual([]);
  });

  it("compares with Decimals: a negative huge value is out of range, a positive one is not", () => {
    const hugeNegative = { sign: -1, layer: 8, mag: 5 };
    expect(summary(validateGameDefinition(mutated((d) => (d.currencies[0].gainMult = hugeNegative))))).toContain("outOfRange currencies.0.gainMult");
  });
});

describe("validateGameDefinition — constant price", () => {
  it("accepts a capped upgrade with a linear coeff-0 price", () => {
    expect(validateGameDefinition(mutated((d) => (d.upgrades[1].scaling = lin(5, 0, { offset: 0 }))))).toEqual([]);
  });

  it("rejects the same price without max", () => {
    const issues = validateGameDefinition(mutated((d) => delete d.upgrades[1].max));
    expect(summary(issues)).toEqual(["outOfRange upgrades.1.scaling.coeff"]);
  });

  it("rejects it on a producer, even with a max", () => {
    const issues = validateGameDefinition(mutated((d) => (d.producers[1].scaling = lin(5, 0))));
    expect(summary(issues)).toEqual(["outOfRange producers.1.scaling.coeff"]);
  });

  it("rejects it with a base of 0 or a non-zero offset", () => {
    expect(summary(validateGameDefinition(mutated((d) => (d.upgrades[1].scaling = lin(0, 0)))))).toContain("outOfRange upgrades.1.scaling.base");
    expect(summary(validateGameDefinition(mutated((d) => (d.upgrades[1].scaling = lin(5, 0, { offset: 3 })))))).toEqual(["outOfRange upgrades.1.scaling.coeff"]);
  });

  it("rejects a decreasing curve even with a max", () => {
    expect(summary(validateGameDefinition(mutated((d) => (d.upgrades[1].scaling = lin(5, -1)))))).toEqual(["outOfRange upgrades.1.scaling.coeff"]);
    expect(summary(validateGameDefinition(mutated((d) => (d.upgrades[1].scaling = geo(5, 0.5)))))).toEqual(["outOfRange upgrades.1.scaling.coeff"]);
  });
});

describe("validateGameDefinition — cost curve support", () => {
  it("rejects logarithmic as a cost curve", () => {
    const issues = validateGameDefinition(mutated((d) => (d.producers[0].scaling = { base: 1, coeff: 1, func: "logarithmic", scaleOn: "self" })));
    expect(summary(issues)).toEqual(["unsupportedCostCurve producers.0.scaling.func"]);
  });

  it("rejects scaleOn other on a cost curve", () => {
    const issues = validateGameDefinition(mutated((d) => (d.upgrades[0].scaling.scaleOn = "other")));
    expect(summary(issues)).toEqual(["unsupportedCostCurve upgrades.0.scaling.scaleOn"]);
  });

  it("still allows scaleOn other and logarithmic on effects and prestiges", () => {
    const def = mutated((d) => {
      d.upgrades[0].effects[0].func = { base: 1, coeff: 1, func: "logarithmic", scaleOn: "other" };
    });
    expect(validateGameDefinition(def)).toEqual([]);
  });
});

describe("validateGameDefinition — registries from the context", () => {
  const customGrowths = (): GrowthRegistry => {
    const growths = new GrowthRegistry();
    growths.register({
      id: "cubic",
      version: "1.0.0",
      compute: (base) => N(base),
      capabilities: { hasClosedFormSum: false, hasClosedFormNmax: false },
    });
    return growths;
  };

  it("reports a custom growth method as unknown without it, and accepts it with it", () => {
    const def = mutated((d) => (d.upgrades[0].effects[0].func = { base: 0, coeff: 0, func: "cubic", scaleOn: "self" }));
    expect(summary(validateGameDefinition(def))).toEqual(["unknownGrowth upgrades.0.effects.0.func.func"]);
    expect(validateGameDefinition(def, { growths: customGrowths() })).toEqual([]);
  });

  it("applies the domain of a custom method registered on the context", () => {
    const growths = new GrowthRegistry();
    growths.register({
      id: "bounded",
      version: "1.0.0",
      compute: (base) => N(base),
      capabilities: { hasClosedFormSum: false, hasClosedFormNmax: false, domain: { coeff: { min: 1 } } },
    });
    const def = mutated((d) => (d.upgrades[0].effects[0].func = { base: 1, coeff: 0.5, func: "bounded", scaleOn: "self" }));
    const issues = validateGameDefinition(def, { growths });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "outOfRange", path: ["upgrades", 0, "effects", 0, "func", "coeff"], range: { min: 1 } });
  });

  it("rejects a custom method without closed forms as a cost curve", () => {
    const def = mutated((d) => (d.producers[0].scaling = { base: 1, coeff: 1, func: "cubic", scaleOn: "self" }));
    expect(summary(validateGameDefinition(def, { growths: customGrowths() }))).toEqual(["unsupportedCostCurve producers.0.scaling.func"]);
  });
});

describe("validateGameDefinition — collisions between currencies and producers", () => {
  it("flags the producer that reuses a currency code", () => {
    const issues = validateGameDefinition(mutated((d) => (d.producers[1].code = "gold")));
    expect(issues.filter((i) => i.code === "duplicateCode").map((i) => i.path.join("."))).toEqual(["producers.1.code"]);
  });
});

describe("parseGameDefinition — on top of validateGameDefinition", () => {
  it("returns the very same object when the definition is valid", () => {
    const def = validDefinition();
    expect(parseGameDefinition(def)).toBe(def);
  });

  it("throws listing every finding, with its path", () => {
    const def = mutated((d) => ((d.clickable.gain = 0), (d.prestiges[0].source.code = "nope")));
    expect(() => parseGameDefinition(def)).toThrow(/^Invalid game definition: .*clickable\.gain.*; .*prestiges\.0\.source\.code/);
  });

  it("throws on input that is not an object", () => {
    expect(() => parseGameDefinition(null)).toThrow(/Invalid game definition/);
  });
});
