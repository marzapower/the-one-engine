import { describe, expect, it } from "vitest";

import { MAX_CATCHUP_MS_PER_TICK, MAX_OFFLINE_MS, TICK_MS_INTERVAL, offlineTickLength, silentLogger } from "../index";
import type { TimeProvider } from "../index";
import { N } from "../nums";
import { type GameState, createInitialState } from "../state";
import { MockTimeProvider } from "../testing";
import { makeScaleState } from "../testing/scale-fixture";
import { DefaultTimeProvider } from "./di/defaults";
import { Engine } from "./engine";

function setup(step = 10, start = 1000, state = createInitialState()) {
  const time = new MockTimeProvider(step);
  time.advance(start);
  const engine = new Engine(step, { time, logger: silentLogger });
  state.lastTick = start;
  return { engine, state, time };
}

// This provider deliberately has no advance(): it models a browser clock.
function manualClock(step = 10, start = 1000) {
  let current = start;
  let tickLength = step;
  const time: TimeProvider = {
    now: () => current,
    getTickLength: () => tickLength,
    setTickLength: (ms) => {
      tickLength = ms;
    },
  };
  return {
    time,
    elapse: (ms: number) => {
      current += ms;
    },
  };
}

function observeSteps(engine: Engine) {
  const elapsed: number[] = [];
  engine.stages.register({
    id: "ObserveTimeContract",
    version: "1.0.0",
    priority: 900,
    run: (ctx) => {
      elapsed.push(ctx.elapsed);
    },
  });
  return elapsed;
}

function economy(state: GameState) {
  return {
    currencies: state.currencies,
    producers: state.producers,
    upgrades: state.upgrades,
    prestiges: state.prestiges,
    ticks: state.stats.ticks,
  };
}

function expectClockBound(state: GameState, now: number, step: number) {
  expect(state.lastTick).toBeDefined();
  expect(state.lastTick!).toBeLessThanOrEqual(now + 1e-6 * step);
  expect(now - state.lastTick!).toBeLessThan(step + 1e-6);
}

describe("Engine time contract: fixed steps and debt", () => {
  it("exports the public catch-up budget and offline cap", () => {
    expect(MAX_CATCHUP_MS_PER_TICK).toBe(60_000);
    expect(MAX_OFFLINE_MS).toBe(86_400_000);
  });

  it.each([0, 1000])("bootstraps exactly one step at now=%s and does not bootstrap twice", (start) => {
    const { engine, state, time } = setup(10, start);
    state.lastTick = undefined;
    const steps = observeSteps(engine);

    expect(engine.tick(state)).toEqual({ processedMs: 10, pendingMs: 0 });
    expect(state.lastTick).toBe(time.now());
    expect(state.stats.ticks).toBe(1);
    expect(steps).toEqual([10]);
    expect(engine.tick(state)).toEqual({ processedMs: 0, pendingMs: 0 });
    expect(state.stats.ticks).toBe(1);
    expect(state.stats.fastSkippedFrames).toBe(1);
  });

  it("treats lastTick === 0 as an initialized cursor", () => {
    const { engine, state, time } = setup(10, 0);
    time.advance(35);

    expect(engine.tick(state)).toEqual({ processedMs: 30, pendingMs: 5 });
    expect(state.lastTick).toBe(30);
    expect(state.stats.ticks).toBe(3);
  });

  it("preserves a substep residue across repeated calls at the same now", () => {
    const { engine, state, time } = setup();
    time.advance(9);
    for (let i = 0; i < 4; i++) {
      expect(engine.tick(state)).toEqual({ processedMs: 0, pendingMs: 9 });
      expect(state.lastTick).toBe(1000);
    }
    expect(state.stats.ticks).toBe(0);
    expect(state.stats.fastSkippedFrames).toBe(4);
    expect(state.stats.slowSkippedFrames).toBe(0);

    time.advance(1);
    expect(engine.tick(state)).toEqual({ processedMs: 10, pendingMs: 0 });
    expect(state.stats.ticks).toBe(1);
  });

  it("repairs a future cursor without simulating or counting a slow frame", () => {
    const { engine, state, time } = setup();
    state.lastTick = 1100;
    const before = structuredClone(economy(state));

    expect(engine.backlogMs(state)).toBe(0);
    expect(state.lastTick).toBe(1100);
    expect(engine.tick(state)).toEqual({ processedMs: 0, pendingMs: 0 });
    expect(state.lastTick).toBe(1000);
    expect(economy(state)).toEqual(before);
    expect(state.stats.fastSkippedFrames).toBe(1);
    expect(state.stats.slowSkippedFrames).toBe(0);

    time.advance(10);
    expect(engine.tick(state)).toEqual({ processedMs: 10, pendingMs: 0 });
  });

  it("runs 1200 regular foreground frames at 1000/60 without losing steps", () => {
    const step = 1000 / 60;
    const { engine, state, time } = setup(step, 1_000_000);
    const steps = observeSteps(engine);
    for (let frame = 1; frame <= 1200; frame++) {
      time.advance(step);
      const result = engine.tick(state);
      expect(result.processedMs).toBe(step);
      expect(result.pendingMs).toBeGreaterThanOrEqual(0);
      expect(result.pendingMs).toBeLessThan(step + 1e-6);
      expect(state.stats.ticks).toBe(frame);
      expectClockBound(state, time.now(), step);
    }
    expect(steps).toHaveLength(1200);
    expect(steps.every((elapsed) => elapsed === step)).toBe(true);
    expect(state.stats.movingAvgTime).toBeCloseTo(step, 9);
    expect(state.stats.lastTicks.every((elapsed) => elapsed === step)).toBe(true);
  });

  it("conserves elapsed time through jitter, duplicate callbacks and fractional residues", () => {
    const step = 1000 / 60;
    const { engine, state, time } = setup(step, 1_000_000);
    const schedule = [1, 7, 0, 33, 2, 51, 5, 101];
    let elapsed = 0;
    let processed = 0;
    for (let frame = 0; frame < 320; frame++) {
      const interval = schedule[frame % schedule.length]!;
      elapsed += interval;
      time.advance(interval);
      const result = engine.tick(state);
      processed += result.processedMs;
      expect(state.stats.ticks).toBe(Math.floor(elapsed / step + 1e-6));
      expect(result.pendingMs).toBeGreaterThanOrEqual(0);
      expect(Math.abs(processed + result.pendingMs - elapsed)).toBeLessThan(1e-6 * step);
      expectClockBound(state, time.now(), step);
    }
  });

  it("accepts cancellation within the relative epsilon but not a genuinely early step", () => {
    const step = 1000 / 60;
    const early = setup(step, 0);
    early.time.advance(step * (1 - 2e-6));
    expect(early.engine.tick(early.state).processedMs).toBe(0);
    expect(early.state.lastTick).toBe(0);

    const rounded = setup(step, 0);
    rounded.time.advance(step * (1 - 0.5e-6));
    expect(rounded.engine.tick(rounded.state)).toEqual({ processedMs: step, pendingMs: 0 });
    expectClockBound(rounded.state, rounded.time.now(), step);
  });

  it("recovers a five-second stall as 300 fixed steps", () => {
    const step = 1000 / 60;
    const { engine, state, time } = setup(step);
    const steps = observeSteps(engine);
    time.advance(5000);

    const result = engine.tick(state);
    expect(result.processedMs).toBeCloseTo(5000, 9);
    expect(result.pendingMs).toBeCloseTo(0, 9);
    expect(state.stats.ticks).toBe(300);
    expect(steps).toEqual(Array<number>(300).fill(step));
    expect(state.stats.slowSkippedFrames).toBe(0);
    expectClockBound(state, time.now(), step);
  });

  it("recovers ten one-minute background intervals without changing step size", () => {
    const step = 1000 / 60;
    const { engine, state, time } = setup(step);
    const steps = observeSteps(engine);
    for (let minute = 1; minute <= 10; minute++) {
      time.advance(60_000);
      const result = engine.tick(state);
      expect(result.processedMs).toBeCloseTo(60_000, 7);
      expect(result.pendingMs).toBeCloseTo(0, 7);
      expect(state.stats.ticks).toBe(minute * 3600);
      expectClockBound(state, time.now(), step);
    }
    expect(steps).toHaveLength(36_000);
    expect(steps.every((elapsed) => elapsed === step)).toBe(true);
    expect(state.stats.slowSkippedFrames).toBe(0);
  });

  it("keeps the default budget's excess and residue for subsequent calls at the same now", () => {
    const { engine, state, time } = setup(1000);
    time.advance(125_500);

    expect(engine.tick(state)).toEqual({ processedMs: 60_000, pendingMs: 65_500 });
    expect(engine.tick(state)).toEqual({ processedMs: 60_000, pendingMs: 5500 });
    expect(engine.tick(state)).toEqual({ processedMs: 5000, pendingMs: 500 });
    expect(engine.tick(state)).toEqual({ processedMs: 0, pendingMs: 500 });
    expect(state.lastTick).toBe(126_000);
    expect(state.stats.ticks).toBe(125);
    expect(state.stats.slowSkippedFrames).toBe(2);
    expect(state.stats.fastSkippedFrames).toBe(1);
  });

  it("floors a custom budget to whole steps and counts only calls that defer due steps", () => {
    const { engine, state, time } = setup();
    time.advance(105);
    for (const pendingMs of [75, 45, 15]) {
      expect(engine.tick(state, { budgetMs: 35 })).toEqual({ processedMs: 30, pendingMs });
    }
    expect(engine.tick(state, { budgetMs: 35 })).toEqual({ processedMs: 10, pendingMs: 5 });
    expect(state.stats.ticks).toBe(10);
    expect(state.stats.slowSkippedFrames).toBe(3);
    expect(state.stats.fastSkippedFrames).toBe(0);
  });

  it("uses the relative epsilon when a budget is almost an exact number of fractional steps", () => {
    const step = 1000 / 60;
    const { engine, state, time } = setup(step, 0);
    time.advance(10 * step);

    const result = engine.tick(state, { budgetMs: 3 * step - step * 0.5e-6 });
    expect(result.processedMs).toBe(3 * step);
    expect(state.stats.ticks).toBe(3);
    expect(result.pendingMs).toBeCloseTo(7 * step, 9);
  });

  it("allows one due step when budget is smaller than step, without inventing a due step", () => {
    const { engine, state, time } = setup(15.625);
    time.advance(31.25);
    expect(engine.tick(state, { budgetMs: 1 })).toEqual({ processedMs: 15.625, pendingMs: 15.625 });
    expect(engine.tick(state, { budgetMs: 1 })).toEqual({ processedMs: 15.625, pendingMs: 0 });
    time.advance(1);
    expect(engine.tick(state, { budgetMs: 1 })).toEqual({ processedMs: 0, pendingMs: 1 });
    expect(state.stats.ticks).toBe(2);
    expect(state.stats.slowSkippedFrames).toBe(1);
  });

  it("recovers a debt greater than 24 hours completely over bounded calls", () => {
    const step = 3_600_000;
    const { engine, state, time } = setup(step, 0);
    // A large step exercises the no-cap rule with only 49 simulation steps.
    const debt = 49 * step + 123;
    time.advance(debt);
    let processed = 0;
    for (let call = 1; call <= 49; call++) {
      const result = engine.tick(state);
      processed += result.processedMs;
      expect(result).toEqual({ processedMs: step, pendingMs: debt - call * step });
    }
    expect(processed).toBe(49 * step);
    expect(processed).toBeGreaterThan(MAX_OFFLINE_MS);
    expect(engine.backlogMs(state)).toBe(123);
    expect(state.stats.ticks).toBe(49);
    expect(state.stats.slowSkippedFrames).toBe(48);
    expect(engine.tick(state)).toEqual({ processedMs: 0, pendingMs: 123 });
  });

  it("divides a pending millisecond residue by the new step", () => {
    const { engine, state, time } = setup(10);
    time.advance(27);
    expect(engine.tick(state)).toEqual({ processedMs: 20, pendingMs: 7 });
    engine.setTickLength(4);
    expect(state.lastTick).toBe(1020);
    expect(engine.tick(state)).toEqual({ processedMs: 4, pendingMs: 3 });
    engine.setTickLength(15.625);
    expect(engine.tick(state)).toEqual({ processedMs: 0, pendingMs: 3 });
    time.advance(12.625);
    expect(engine.tick(state)).toEqual({ processedMs: 15.625, pendingMs: 0 });
    expect(state.stats.ticks).toBe(4);
    expect(state.stats.lastTicks).toEqual([10, 10, 4, 15.625]);
  });

  it("uses the entry clock snapshot even if wall time passes inside simulation", () => {
    const clock = manualClock();
    const engine = new Engine(10, { time: clock.time, logger: silentLogger });
    const state = createInitialState();
    state.lastTick = 1000;
    engine.stages.register({ id: "WallTime", version: "1.0.0", priority: 900, run: () => clock.elapse(3) });
    clock.elapse(20);

    expect(engine.tick(state)).toEqual({ processedMs: 20, pendingMs: 0 });
    expect(state.lastTick).toBe(1020);
    expect(engine.backlogMs(state)).toBe(6);
    expect(state.stats.ticks).toBe(2);
  });
});

describe("Engine time contract: input validation", () => {
  const invalid = [0, -0, -1, NaN, Infinity, -Infinity];

  it.each(invalid)("rejects tickLength=%s in the constructor", (step) => {
    expect(() => new Engine(step, { logger: silentLogger })).toThrow(RangeError);
  });

  it.each(invalid)("rejects setTickLength(%s) without damaging the previous step", (step) => {
    const { engine, state, time } = setup(10);
    expect(() => engine.setTickLength(step)).toThrow(RangeError);
    time.advance(20);
    expect(engine.tick(state)).toEqual({ processedMs: 20, pendingMs: 0 });
    expect(state.stats.ticks).toBe(2);
  });

  it.each(invalid)("rejects budgetMs=%s before simulating or consuming debt", (budgetMs) => {
    const { engine, state, time } = setup();
    time.advance(100);
    const before = structuredClone(economy(state));
    expect(() => engine.tick(state, { budgetMs })).toThrow(RangeError);
    expect(economy(state)).toEqual(before);
    expect(state.lastTick).toBe(1000);
    expect(state.stats.lastTicks).toEqual([]);
  });

  it.each(invalid)("also rejects budgetMs=%s at bootstrap and when no step is due", (budgetMs) => {
    for (const lastTick of [undefined, 1000]) {
      const { engine, state } = setup();
      state.lastTick = lastTick;
      expect(() => engine.tick(state, { budgetMs })).toThrow(RangeError);
      expect(state.lastTick).toBe(lastTick);
      expect(state.stats.ticks).toBe(0);
    }
  });
});

describe("Engine time contract: backlog and pause", () => {
  it("reports backlog without mutating a bootstrap, running, future or paused cursor", () => {
    const { engine, state, time } = setup();
    for (const [lastTick, pausedAt, expected] of [
      [undefined, undefined, 0],
      [0, undefined, 1000],
      [975.5, undefined, 24.5],
      [1100, undefined, 0],
      [0, 0, 0],
    ] as const) {
      state.lastTick = lastTick;
      state.pausedAt = pausedAt;
      const before = structuredClone(state);
      expect(engine.backlogMs(state)).toBe(expected);
      expect(state).toEqual(before);
      expect(time.now()).toBe(1000);
    }
  });

  it("consumes exactly the requested backlog, including fractions, without simulation", () => {
    const { engine, state, time } = setup(10, 0, makeScaleState(2, 2, 2));
    time.advance(100);
    const before = structuredClone(state);
    expect(engine.consumeBacklog(state, 25.5)).toBe(25.5);
    expect(state).toEqual({ ...before, lastTick: 25.5 });
    expect(engine.backlogMs(state)).toBe(74.5);
    expect(engine.consumeBacklog(state, 1000)).toBe(74.5);
    expect(state).toEqual({ ...before, lastTick: 100 });
    expect(engine.consumeBacklog(state, 1)).toBe(0);
    expect(engine.tick(state)).toEqual({ processedMs: 0, pendingMs: 0 });
  });

  it("leaves unconsumed debt available for normal fixed-step simulation", () => {
    const { engine, state, time } = setup();
    time.advance(105);
    expect(engine.consumeBacklog(state, 32)).toBe(32);
    expect(engine.tick(state)).toEqual({ processedMs: 70, pendingMs: 3 });
    expect(state.stats.ticks).toBe(7);
    expect(state.lastTick).toBe(1102);
  });

  it("does not consume time during bootstrap, pause or a future cursor", () => {
    const { engine, state } = setup();
    for (const [lastTick, pausedAt] of [
      [undefined, undefined],
      [0, 0],
      [1100, undefined],
    ] as const) {
      state.lastTick = lastTick;
      state.pausedAt = pausedAt;
      const before = structuredClone(state);
      expect(engine.consumeBacklog(state, 500)).toBe(0);
      expect(state).toEqual(before);
    }
    state.lastTick = 0;
    state.pausedAt = undefined;
    const before = structuredClone(state);
    expect(engine.consumeBacklog(state, 0)).toBe(0);
    expect(state).toEqual(before);
  });

  it("recognizes a pause at time zero and makes paused ticks complete no-ops", () => {
    const { engine, state, time } = setup(10, 0);
    engine.pauseClock(state);
    expect(state.pausedAt).toBe(0);
    const paused = structuredClone(state);
    time.advance(100);
    engine.pauseClock(state);
    expect(engine.tick(state)).toEqual({ processedMs: 0, pendingMs: 0 });
    expect(engine.backlogMs(state)).toBe(0);
    expect(state).toEqual(paused);
    engine.resumeClock(state);
    expect(state.lastTick).toBe(100);
    expect(state.pausedAt).toBeUndefined();
    const resumed = structuredClone(state);
    engine.resumeClock(state);
    expect(state).toEqual(resumed);
  });

  it("retains pre-pause debt midway through catch-up and excludes exactly the pause duration", () => {
    const { engine, state, time } = setup();
    const startedAt = time.now();
    time.advance(1000);
    let processed = engine.tick(state, { budgetMs: 200 }).processedMs;
    expect(engine.backlogMs(state)).toBe(800);
    engine.pauseClock(state);
    time.advance(500);
    engine.pauseClock(state);
    expect(state.pausedAt).toBe(2000);
    time.advance(2500);
    const paused = structuredClone(state);
    expect(engine.tick(state)).toEqual({ processedMs: 0, pendingMs: 0 });
    expect(state).toEqual(paused);
    engine.resumeClock(state);
    expect(state.lastTick).toBe(4200);
    expect(engine.backlogMs(state)).toBe(800);
    time.advance(250);
    for (const [processedMs, pendingMs] of [
      [500, 550],
      [500, 50],
      [50, 0],
    ]) {
      const result = engine.tick(state, { budgetMs: 500 });
      expect(result).toEqual({ processedMs, pendingMs });
      processed += result.processedMs;
    }
    expect(processed).toBe(time.now() - startedAt - 3000);
    expect(processed).toBe(1250);
    expect(state.stats.ticks).toBe(125);
    expect(state.lastTick).toBe(time.now());
  });

  it("preserves an uninitialized cursor through pause and resume", () => {
    const { engine, state, time } = setup();
    state.lastTick = undefined;
    engine.pauseClock(state);
    time.advance(5000);
    const paused = structuredClone(state);
    expect(engine.tick(state)).toEqual({ processedMs: 0, pendingMs: 0 });
    expect(state).toEqual(paused);
    engine.resumeClock(state);
    expect(state.lastTick).toBeUndefined();
    expect(engine.tick(state)).toEqual({ processedMs: 10, pendingMs: 0 });
    expect(state.lastTick).toBe(6000);
    expect(state.stats.ticks).toBe(1);
  });
});

describe("Engine time contract: advance and offline integration", () => {
  it.each([10, 15.625])("matches advance economically at exact binary step %s", (step) => {
    const live = setup(step, 1000, makeScaleState(3, 2, 3));
    const headless = setup(step, 1000, structuredClone(live.state));
    expect(live.time).not.toBe(headless.time);
    expect(live.engine).not.toBe(headless.engine);
    for (const count of [1, 7, 32, 3, 19]) {
      live.time.advance(count * step);
      // Multiple calls at the same now exercise deferred debt too.
      for (let done = 0; done < count; done += 4) {
        live.engine.tick(live.state, { budgetMs: 4 * step });
      }
      headless.engine.advance(headless.state, count * step);
      expect(economy(live.state)).toEqual(economy(headless.state));
    }
    expect(live.state.stats.ticks).toBe(62);
    expect(N(live.state.currencies[0]!.amount).gt(0)).toBe(true);
  });

  it("composes tick, default offline simulation and tick without replaying offline time", () => {
    const live = setup(10, 1000, makeScaleState(2, 2, 2));
    const reference = setup(10, 1000, structuredClone(live.state));
    live.time.advance(20);
    expect(live.engine.tick(live.state)).toEqual({ processedMs: 20, pendingMs: 0 });
    reference.engine.advance(reference.state, 20);

    const report = live.engine.simulateOffline(live.state, 60_000);
    expect(report.tickLengthUsed).toBe(250);
    expect(report.ticksRun).toBe(240);
    reference.engine.setTickLength(250);
    reference.engine.advance(reference.state, 60_000);
    reference.engine.setTickLength(10);
    expect(live.engine.tick(live.state)).toEqual({ processedMs: 0, pendingMs: 0 });
    live.time.advance(30);
    expect(live.engine.tick(live.state)).toEqual({ processedMs: 30, pendingMs: 0 });
    reference.engine.advance(reference.state, 30);
    expect(economy(live.state)).toEqual(economy(reference.state));
    expect(live.state.stats.ticks).toBe(245);
    expect(live.state.stats.lastTicks.slice(-3)).toEqual([10, 10, 10]);
  });

  it.each([false, true])("matches a single offline run with fixed-step chunks (preserveClock=%s)", (preserveClock) => {
    const whole = setup(15.625, 1000, makeScaleState(3, 2, 3));
    const chunked = setup(15.625, 1000, structuredClone(whole.state));
    const options = { tickLengthMs: 250, preserveClock };
    // Each chunk is a whole number of the chosen coarse step; the chunks
    // straddle the automatic policy's 60s boundary on purpose.
    const report = whole.engine.simulateOffline(whole.state, 90_000, options);
    const deltas = new Map<string, ReturnType<typeof N>>();
    let ticksRun = 0;
    for (const duration of [10_000, 60_000, 20_000]) {
      const chunk = chunked.engine.simulateOffline(chunked.state, duration, options);
      expect(chunk.tickLengthUsed).toBe(250);
      ticksRun += chunk.ticksRun;
      for (const [code, delta] of Object.entries(chunk.deltaCurrencies)) {
        deltas.set(code, (deltas.get(code) ?? N(0)).add(N(delta)));
      }
    }
    expect(ticksRun).toBe(360);
    expect(ticksRun).toBe(report.ticksRun);
    expect(economy(chunked.state)).toEqual(economy(whole.state));
    expect(chunked.state.lastTick).toBe(whole.state.lastTick);
    if (preserveClock) expect(chunked.state.lastTick).toBe(1000);
    for (const [code, delta] of Object.entries(report.deltaCurrencies)) {
      expect(deltas.get(code)!.toNumber()).toBeCloseTo(N(delta).toNumber(), 7);
    }
    // advance() observes the restored normal step without consuming backlog.
    for (const run of [whole, chunked]) {
      const before = run.state.stats.ticks;
      run.engine.advance(run.state, 31.25);
      expect(run.state.stats.ticks).toBe(before + 2);
    }
  });

  it("preserves real time accrued during offline work with a provider that cannot advance", () => {
    const clock = manualClock();
    const engine = new Engine(10, { time: clock.time, logger: silentLogger });
    const state = makeScaleState(1, 1, 0);
    state.lastTick = 1000;
    clock.elapse(1050);
    expect(engine.consumeBacklog(state, 1000)).toBe(1000);
    engine.stages.register({ id: "WallTime", version: "1.0.0", priority: 900, run: () => clock.elapse(25) });

    const report = engine.simulateOffline(state, 1000, { tickLengthMs: 250, preserveClock: true });
    expect(report.ticksRun).toBe(4);
    expect(report.tickLengthUsed).toBe(250);
    expect(state.stats.ticks).toBe(4);
    expect(state.stats.lastTicks).toEqual([250, 250, 250, 250]);
    expect(state.stats.movingAvgTime).toBe(250);
    expect(state.lastTick).toBe(2000);
    expect(clock.time.now()).toBe(2150);
    expect(engine.backlogMs(state)).toBe(150);
    expect(N(report.deltaCurrencies.c0!).gt(0)).toBe(true);
    engine.stages.unregister("WallTime");
    expect(engine.tick(state)).toEqual({ processedMs: 150, pendingMs: 0 });
    expect(state.stats.ticks).toBe(19);
    expect(state.lastTick).toBe(2150);
  });

  it("restores an undefined bootstrap cursor when preserveClock is requested", () => {
    const clock = manualClock();
    const engine = new Engine(10, { time: clock.time, logger: silentLogger });
    const state = createInitialState();
    expect(engine.simulateOffline(state, 500, { tickLengthMs: 250, preserveClock: true }).ticksRun).toBe(2);
    expect(state.lastTick).toBeUndefined();
    expect(engine.tick(state)).toEqual({ processedMs: 10, pendingMs: 0 });
    expect(state.stats.ticks).toBe(3);
  });

  it.each([undefined, 0, 900])("restores step and preserved cursor %s after a stage throws partway through offline simulation", (lastTick) => {
    const clock = manualClock(15.625);
    const engine = new Engine(15.625, { time: clock.time, logger: silentLogger });
    const state = createInitialState();
    state.lastTick = lastTick;
    const failure = new Error("Injected stage failure");
    let calls = 0;
    engine.stages.register({
      id: "FailOffline",
      version: "1.0.0",
      priority: 900,
      run: () => {
        if (++calls === 2) throw failure;
      },
    });

    expect(() => engine.simulateOffline(state, 1000, { tickLengthMs: 250, preserveClock: true })).toThrow(failure);
    expect(calls).toBe(2);
    expect(state.lastTick).toBe(lastTick);
    engine.stages.unregister("FailOffline");
    const before = state.stats.ticks;
    const steps = observeSteps(engine);
    engine.advance(state, 31.25);
    expect(state.stats.ticks).toBe(before + 2);
    expect(steps).toEqual([15.625, 15.625]);
  });

  it.each([false, true])("does no offline work while paused (preserveClock=%s)", (preserveClock) => {
    const { engine, state, time } = setup(10, 0, makeScaleState(2, 2, 2));
    engine.pauseClock(state);
    time.advance(1000);
    const before = structuredClone(state);

    const report = engine.simulateOffline(state, 60_000, { tickLengthMs: 250, preserveClock });
    expect(report.durationMs).toBe(0);
    expect(report.ticksRun).toBe(0);
    for (const delta of Object.values(report.deltaCurrencies)) expect(N(delta).eq(0)).toBe(true);
    expect(state).toEqual(before);
    expect(time.now()).toBe(1000);
    engine.resumeClock(state);
    time.advance(10);
    expect(engine.tick(state)).toEqual({ processedMs: 10, pendingMs: 0 });
  });

  it("restores the normal step after a failed offline run with default options", () => {
    const { engine, state } = setup(15.625);
    const failure = new Error("Injected default offline failure");
    engine.stages.register({
      id: "FailOffline",
      version: "1.0.0",
      priority: 900,
      run: () => {
        throw failure;
      },
    });
    expect(() => engine.simulateOffline(state, 60_000)).toThrow(failure);
    engine.stages.unregister("FailOffline");
    const before = state.stats.ticks;
    const steps = observeSteps(engine);
    engine.advance(state, 31.25);
    expect(state.stats.ticks).toBe(before + 2);
    expect(steps).toEqual([15.625, 15.625]);
  });

  it("returns a zero report for default offline simulation during a bootstrap pause", () => {
    const { engine, state, time } = setup();
    state.lastTick = undefined;
    engine.pauseClock(state);
    time.advance(1000);
    const before = structuredClone(state);
    const report = engine.simulateOffline(state, 60_000);
    expect(report.durationMs).toBe(0);
    expect(report.ticksRun).toBe(0);
    expect(state).toEqual(before);
    expect(time.now()).toBe(2000);
  });

  it("applies the 24-hour cap only to offline simulation, even with an explicit coarse step", () => {
    const { engine, state } = setup();
    const report = engine.simulateOffline(state, 49 * 3_600_000, { tickLengthMs: 3_600_000, preserveClock: true });
    expect(report.durationRequestedMs).toBe(49 * 3_600_000);
    expect(report.durationMs).toBe(MAX_OFFLINE_MS);
    expect(report.durationCapped).toBe(true);
    expect(report.tickLengthUsed).toBe(3_600_000);
    expect(report.ticksRun).toBe(24);
    expect(state.stats.ticks).toBe(24);
    expect(state.lastTick).toBe(1000);
  });
});

describe("offlineTickLength", () => {
  it.each([
    [0, TICK_MS_INTERVAL],
    [59_999.999, TICK_MS_INTERVAL],
    [60_000, 250],
    [60_000.001, 250],
    [3_599_999.999, 250],
    [3_600_000, 1000],
    [3_600_000.001, 1000],
    [86_400_000, 1000],
    [172_800_000, 1000],
  ])("selects %s ms of offline duration using step %s", (duration, expected) => {
    expect(offlineTickLength(duration)).toBe(expected);
  });
});

describe("clock magnitude", () => {
  it("keeps simulated plus pending time equal to elapsed time at 60 Hz over ten minutes", () => {
    const step = 1000 / 60;
    const start = 3_600_000;
    const clock = manualClock(step, start);
    const engine = new Engine(step, { time: clock.time, logger: silentLogger });
    const state = createInitialState();
    state.lastTick = start;

    let simulated = 0;
    let pending = 0;
    let previous = 0;
    for (let frame = 1; frame <= 36_000; frame++) {
      const now = Math.floor(frame * step);
      clock.elapse(now - previous);
      previous = now;
      const result = engine.tick(state);
      simulated += result.processedMs;
      pending = result.pendingMs;
    }

    expect(Math.abs(simulated + pending - previous)).toBeLessThan(1e-3);
  });

  it("defaults to a small-magnitude monotonic clock rather than a Unix timestamp", () => {
    expect(new DefaultTimeProvider(TICK_MS_INTERVAL).now()).toBeLessThan(1e11);
  });
});

describe("consumeBacklog input", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY])("rejects %s without touching the clock", (ms) => {
    const { engine, state } = setup();
    expect(() => engine.consumeBacklog(state, ms)).toThrow(RangeError);
    expect(state.lastTick).toBe(1000);
  });
});
