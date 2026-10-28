<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/brand/engine.svg">
    <img src=".github/brand/engine-day.svg" alt="The One Engine" width="220">
  </picture>
</p>

# The One Engine

A headless engine for incremental games, written in TypeScript. It runs the
numbers of a game: things that produce other things, prices that climb,
upgrades that multiply, prestige layers that wipe the board and hand you
something permanent in return. It has no UI, no store, no opinion about how
you render anything. You hand it a plain object describing the game, and it
moves that object forward in time.

Runtime dependencies: [break_eternity.js](https://github.com/Patashu/break_eternity.js)
for numbers up to 10^^1.8e308, and [zod](https://zod.dev) for validation.
Nothing else. MIT licensed.

Website and manual: [theoneincremental.com/engine](https://www.theoneincremental.com/engine).
The engine runs [The One Incremental](https://www.theoneincremental.com), a free
browser game, and [The One Builder](https://builder.theoneincremental.com), a
workshop for designing and simulating incremental economies.

## The whole idea in one minute

- **The game is data.** Producers, currencies, upgrades and prestiges are plain
  serializable objects. Put the whole state in a store, in a JSON file or in a
  test fixture: the engine does not care.
- **The engine is a function of time.** Every tick it walks a fixed list of
  stages and mutates the state you gave it. Give it a fake clock and every run
  is deterministic.
- **Effects never overwrite your numbers.** An upgrade that says "×1.15 on the
  output of producer A" is folded onto A's base value at the moment it is read.
  What the designer wrote stays as written, forever.
- **Big numbers are first class.** `N()` for math, `NR()` for storage. A
  `Decimal` is what you compute with; a flat `{ sign, layer, mag }` is what you
  save.
- **Every mechanic beyond the basics is data.** Soft caps, automation, passive
  bonuses driven by lifetime earnings: you switch them on by putting data on the
  state. A state without that data never runs the mechanic.
- **You can simulate before you ship.** A bot plays the game headless and you
  get a report: time per order of magnitude, dead time, prestige cycles.

## Quick start

```ts
import { Engine, N, NR, ScaleOn, ScalingMethod, createInitialState, print } from "the-one-engine";
import { MockTimeProvider } from "the-one-engine/testing";

const state = createInitialState();

state.currencies.push({ code: "gold", name: "Gold", amount: NR(0), resetsOn: [] });

// A mine costs 10 gold, then 10 × 1.15 for the next one, and so on.
// Each mine you own produces 1 gold per second.
state.producers.push({
  code: "mine",
  name: "Mine",
  currencyCode: "gold",
  amount: NR(1),
  bought: NR(1),
  scaling: { base: NR(10), coeff: NR(1.15), func: ScalingMethod.Geometric, scaleOn: ScaleOn.self },
  produces: [{ code: "gold", persec: NR(1) }],
  resetsOn: [],
});

const time = new MockTimeProvider(250);
const engine = new Engine(250, { time });

engine.advance(state, 60_000); // one simulated minute, deterministic

const gold = state.currencies[0]!;
console.log(print(gold.amount)); // "60"
console.log(N(gold.amount).gt(50)); // true
```

## What is in the box

### The tick loop

`engine.tick(state)` is what a real game calls from its interval. The
simulation always advances in fixed steps of `tickLength`: `tick` plays the
backlog `now - lastTick` step by step, up to a budget of game time per call
(`budgetMs`, default `MAX_CATCHUP_MS_PER_TICK` = 60 s; if the step is larger
than the budget, one step runs per call). What is not played stays pending in
`lastTick` and is returned as `pendingMs`, so nothing is silently dropped;
`backlogMs`, `consumeBacklog`, `pauseClock` and `resumeClock` let a host show,
discard or freeze that debt. It also keeps per-stage timing in `state.stats`.
`engine.advance(state, ms)` is the same loop without a clock, for tests and
simulations.

Each tick runs seven stages in a fixed order: upgrades at stage 0, production,
upgrades at stage 1, prestige effects, growth, upgrades at stage 2, automation.
Priorities are spaced 100 apart so an addon can slot a stage in between.

### Producers, currencies, upgrades, prestiges

Four TypeScript interfaces, nothing more.

- A **producer** has a price curve, a count of how many you own, and a list of
  what it produces per second: a currency, or another producer.
- A **currency** has an amount, an optional lifetime `earned` total, a `drive`
  that says which stock of it feeds passive bonuses, and a few multiplier
  channels upgrades can fold onto.
- An **upgrade** carries **effects** (at which stage, on which target, add or
  multiply, by how much per level) and optional **behaviors** (automation).
- A **prestige** converts the value of one target into another, resets
  everything that lists it in `resetsOn`, and carries passive effects driven by
  how much you have earned from it.

Effects and prestiges point at their target with a small path language:
`{ kind: "producer", code: "mine", path: "produces.*.persec" }`. A path that
does not resolve is reported at bootstrap, not discovered at runtime.

### Growth curves with the algebra already done

Every price and every effect is a `GrowthFunction`: base, coefficient,
optional offset, and a shape id looked up in the engine's growth registry.

| Shape                | Next unit costs      |
| -------------------- | -------------------- |
| `linear`             | a + b·x + q          |
| `geometric`          | a · bˣ + q           |
| `exponential`        | a^(b·x) + q          |
| `double_exponential` | a^(bˣ) + q           |
| `logarithmic`        | a · b · log10(x) + q |

`scaleOn` decides whether x is the number you already own (`self`) or the
count of another entity (`other`), which swaps the roles of b and x.

Linear, geometric and exponential have algebraic sums, so quoting "buy 250"
or "how many can I afford" costs one formula each, guarded against the cases
where formulas lie. Double exponential uses bounded sums and checked
estimates; logarithmic is meant for conversions and has no sum.
`engine.costToBuy(item, pool)` quotes the maximum you can afford,
`engine.maxBuyableAmount` returns just the amount, `engine.costToBuyNext(item, n)`
prices an explicit amount. These are quotes: your host applies the purchase.

### Effects that compose without drifting

An effect's result is never written onto a persistent value. Each tick the
engine collects every active effect, orders it by stage, then by the priority
of its effect type (`add` 100, `mult` 200, addons anywhere), then by
declaration order, and folds it onto the base at the point of read. The only
writable channel is `persecDelta`, cleared at the start of every tick.

### Prestige

`engine.performPrestige(state, prestige)` runs the source through the
prestige's growth function, applies the `gainMult` channel, floors to whole
units, credits the target and its lifetime `earned`, resets what should reset,
restores head starts and kept levels. `engine.prestigeGain(state, prestige)`
tells you what it would deliver, for a preview panel.

### Saturation: an optional soft cap

A producer may declare a `capacity`; the state may declare
`rules.saturation`. With both present, output above capacity loses efficiency
on a smooth curve, the lost output can overflow into a currency, that currency
can drag every producer and cool down on a real-time half-life, the capacity
losses and the overflow can stay dormant until a lifetime counter crosses a
gate (drag and cooling, when configured, do not wait for it), and every
capacity can grow as that counter grows. `engine.saturationActive(state)` and
`engine.supportRatio(state, producer)` are the read side for a UI.

### Behaviors: automation as data

An upgrade's `behaviors` are active while its level is at least 1:
`autobuyUpgrades` buys one level per tick of the upgrades a prestige resets,
`prestigeDrip` grants a trickle of the pending prestige gain every second,
`autoPrestige` performs the prestige once the payoff ratio clears a threshold,
`keepLevels` keeps a fraction of levels through a reset. They run in the
automation stage, in that order.

### Offline progress that runs the real rules

`engine.simulateOffline(state, elapsedMs)` runs the same pipeline at a
coarser, configurable step (capped at 24 hours), so the game's feedback loops
keep running offline. Coarser steps can change numerical results and
automation frequency. It returns the delta of every currency.

### Numbers past 1e308

`N(x)` turns a number, a numeric string, a stored value or a `Decimal` into a
`Decimal` you can chain. `NR(x)` turns the same inputs into the flat
`{ sign, layer, mag }` object that belongs in state and save files. `N()` is
strict: it throws on most input it cannot parse instead of silently returning
zero. `print()` and `printF()` format for display, up to `(10^)^9 10.00`.

### Validation at bootstrap

The first tick validates the whole state: duplicate codes, dangling
references, unresolvable paths, price curves out of their shape's domain,
unknown growth or effect ids, behaviors and rules pointing at things that do
not exist. Errors and warnings land in `state.stats` and in the engine's
`Logger`; the game keeps running. Zod schemas validate the shape of a state and
the envelope of a data pack without throwing; validate a pack's payload
yourself before merging it.

### An SDK for addons, bound to one engine

Every `Engine` creates its own growth, effect-type and stage registries by
default; injected registries can be shared on purpose, and built-in growth and
effect definitions should be treated as immutable. `createSdk(engine)` hands a plugin
`registerGrowth`, `registerEffectType`, `registerStage` bound to that engine,
plus the numeric and schema helpers. `loadPlugin(engine, url)` dynamically
imports an ES module and applies its default export, once per engine and URL.
`examples/cubic-addon.ts` shows all three registrations.

### Dependency injection

`new Engine(tickLength, deps)` takes a clock, a state adapter, an entity
registry, an effect resolver, a `Logger`, pre-seeded registries and an
`onPrestige` hook. The defaults work on a plain object and log to the console;
`silentLogger` keeps simulations quiet; the state adapter exposes mutation
hooks, and the engine rebuilds its indexes whenever it sees a new array
reference.

### Balance lab, test doubles, benchmarks

`the-one-engine/balance` plays a game headless: `runBalanceSim` drives a bot
(`GreedyBot` approximates an experienced player), `MetricsCollector` turns the
run into a `BalanceReport` (milestones, time per decade, dead time, decision
density, purchase rotation, prestige cycles, saturation onset), and a
`GameDefinition` describes an entire game as JSON so two versions can be
compared on the same build.

`runCalibration` checks a prestige shop: it plays many purchase orders of the
same upgrades (cheapest first, each upgrade moved first or last, random orders,
a beam search for the best and the worst), compares how fast each order grows
the prestige currency per hour, and flags an order whose curve keeps pulling
away from the median, a best order far ahead at a milestone, and runs that get
longer. Your game plugs in its own moves (`GameMove`) and runs the orders
wherever it likes, in parallel processes too; `renderCalibrationHtml` writes a
self-contained report. The player can be a human profile (sessions, visits,
closed-page time) with automations as bot rules; times are then hours of active
play, and the report adds a table with the first purchase of each upgrade.

`the-one-engine/testing` ships a fake clock, a state adapter that records every
mutation, and a fluent `ScenarioRunner`:

```ts
new ScenarioRunner(state, engine, adapter).advance(60_000).buy("mine", "max").advance(30_000).snapshot();
```

`packages/engine/bench` measures ticks, buy-max quotes and a full balance
simulation, and prints the delta against any previous result:

```bash
pnpm --filter the-one-engine bench -- --label my-change --out bench/results/my-change.json --baseline bench/results/<previous>.json
```

## Design constraints

- **No UI state.** Cooldowns, buy modes and discovery flags belong to the host.
- **No persistence.** The state is trivially serializable; saving it is the
  host's job.
- **No sandboxing of plugins.** `loadPlugin` is a dynamic `import()`; trust is
  the host's decision.
- **No global anything.** Every registry, every default lives on the `Engine`
  you constructed.

## Install and develop

The package is not on npm yet. Consume it from a pnpm workspace or via `link:`:

```json
{ "dependencies": { "the-one-engine": "link:../the-one-engine/packages/engine" } }
```

Entry points: `the-one-engine`, `the-one-engine/balance`,
`the-one-engine/testing`, `the-one-engine/node`.

```bash
pnpm install
pnpm build       # ESM + type declarations into packages/engine/dist
pnpm test
pnpm typecheck
pnpm lint
```

Requires Node 20 or newer and pnpm 9.

## License

MIT. Copyright 2026 Daniele Di Bernardo.
