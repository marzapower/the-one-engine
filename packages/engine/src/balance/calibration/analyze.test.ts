import { describe, expect, it } from "vitest";

import { analyzeCalibration, formatHours, rateSeries } from "./analyze";
import type { OrderItem, OrderOrigin, OrderResult, RunRecord } from "./types";

const H = 3_600_000;

const order = (...codes: string[]): OrderItem[] => codes.map((code) => ({ code, level: 1 }));

/** One run per hour, ending on each hour mark, with the given rates (per hour). */
function hourlyRuns(rates: number[]): RunRecord[] {
  return rates.map((ratePerHour, i) => ({ index: i, startMs: i * H, endMs: (i + 1) * H, gain: ratePerHour, ratePerHour }));
}

function make(id: string, origin: OrderOrigin, runs: RunRecord[], extra: Partial<OrderResult> = {}): OrderResult {
  return {
    id,
    origin,
    order: order("a", "b", "c"),
    purchases: [],
    runs,
    milestoneTimes: {},
    horizonMs: 6 * H,
    endedAtMs: 6 * H,
    ...extra,
  };
}

const constant = (rate: number) => hourlyRuns([rate, rate, rate, rate, rate, rate]);

describe("analyzeCalibration", () => {
  it("raises no shape alarm for constant rates that differ by scale only", () => {
    const analysis = analyzeCalibration([make("ref", "reference", constant(100)), make("rnd:1", "random", constant(105)), make("rnd:2", "random", constant(95))], []);
    expect(analysis.grid).toEqual([0, H, 2 * H, 3 * H, 4 * H, 5 * H, 6 * H]);
    expect(analysis.alarms.filter((a) => a.kind === "shape")).toEqual([]);
    expect(analysis.gaps["ref"]?.[0]).toBeNull();
  });

  it("raises a shape alarm on an order whose rate doubles every hour, with its first divergence", () => {
    const fast = make("rnd:fast", "random", hourlyRuns([100, 200, 400, 800, 1600, 3200]), { order: order("b", "a", "c") });
    const analysis = analyzeCalibration([make("ref", "reference", constant(100)), make("rnd:1", "random", constant(105)), make("rnd:2", "random", constant(95)), fast], []);
    const shape = analysis.alarms.filter((a) => a.kind === "shape");
    expect(shape).toHaveLength(1);
    expect(shape[0]?.orderId).toBe("rnd:fast");
    expect(shape[0]?.firstDivergence).toEqual({ code: "b", level: 1 });
    expect(shape[0]?.detail).toMatch(/decad/);
  });

  it("raises a shift alarm at ratio 2.5 and none at 1.5 (threshold 2)", () => {
    const build = (medianHours: number) => {
      const times = [2, medianHours, medianHours, medianHours];
      return times.map((t, i) => make(i === 0 ? "ref" : `rnd:${i}`, i === 0 ? "reference" : "random", constant(100), { milestoneTimes: { "10": t * H } }));
    };
    const hi = analyzeCalibration(build(5), [10]);
    expect(hi.milestoneSummary["10"]).toEqual({ best: 2 * H, median: 5 * H, ratio: 2.5 });
    expect(hi.alarms.filter((a) => a.kind === "shift").map((a) => a.milestone)).toEqual(["10"]);
    const lo = analyzeCalibration(build(3), [10]);
    expect(lo.milestoneSummary["10"]?.ratio).toBe(1.5);
    expect(lo.alarms.filter((a) => a.kind === "shift")).toEqual([]);
  });

  it("raises a shift alarm when the best order reaches a milestone the median never does", () => {
    const results = [
      make("ref", "reference", constant(100), { milestoneTimes: { "10": 2 * H } }),
      make("rnd:1", "random", constant(100), { milestoneTimes: { "10": null } }),
      make("rnd:2", "random", constant(100), { milestoneTimes: { "10": null } }),
    ];
    const analysis = analyzeCalibration(results, [10]);
    expect(analysis.milestoneSummary["10"]).toEqual({ best: 2 * H, median: null, ratio: null });
    const shift = analysis.alarms.filter((a) => a.kind === "shift");
    expect(shift.map((a) => a.orderId)).toEqual(["ref"]);
    expect(shift[0]?.detail).toMatch(/orizzonte/);
  });

  it("treats censored milestones as slower than all and never produces NaN", () => {
    const results = [
      make("ref", "reference", constant(100), { milestoneTimes: { "10": 2 * H } }),
      make("rnd:1", "random", constant(100), { milestoneTimes: { "10": 3 * H } }),
      make("rnd:2", "random", constant(100), { milestoneTimes: { "10": 3 * H } }),
      make("rnd:never", "random", [], { milestoneTimes: { "10": null } }),
    ];
    const analysis = analyzeCalibration(results, [10]);
    // sorted: 2h, 3h, 3h, +inf -> median 3h (the censored order does not lower it)
    expect(analysis.milestoneSummary["10"]).toEqual({ best: 2 * H, median: 3 * H, ratio: 1.5 });
    expect(analysis.gaps["rnd:never"]?.every((g) => g === null)).toBe(true);
    expect(JSON.stringify(analysis)).not.toMatch(/NaN|Infinity/);

    const allCensored = analyzeCalibration(
      [make("ref", "reference", [], { milestoneTimes: { "10": null } }), make("rnd:1", "random", [], { milestoneTimes: { "10": null } })],
      [10],
    );
    expect(allCensored.milestoneSummary["10"]).toEqual({ best: null, median: null, ratio: null });
    expect(JSON.stringify(allCensored)).not.toMatch(/NaN|Infinity/);
  });

  it("raises a pace alarm when run durations keep growing, not when they shrink", () => {
    const runsOf = (hours: number[]): RunRecord[] => {
      let t = 0;
      return hours.map((d, index) => {
        const startMs = t;
        t += d * H;
        return { index, startMs, endMs: t, gain: 10, ratePerHour: 10 / d };
      });
    };
    const growing = analyzeCalibration([make("ref", "reference", runsOf([2, 2.3, 2.6, 3]))], []);
    expect(growing.alarms.filter((a) => a.kind === "pace").map((a) => a.orderId)).toEqual(["ref"]);
    const shrinking = analyzeCalibration([make("ref", "reference", runsOf([3, 2.5, 2, 1.8]))], []);
    expect(shrinking.alarms.filter((a) => a.kind === "pace")).toEqual([]);
  });

  it("computes per-upgrade sensitivity against the reference", () => {
    const analysis = analyzeCalibration(
      [
        make("ref", "reference", constant(100), { milestoneTimes: { "10": 4 * H } }),
        make("ant:a", "anticipate", constant(100), { subject: "a", milestoneTimes: { "10": 3 * H } }),
        make("del:a", "delay", constant(100), { subject: "a", milestoneTimes: { "10": null } }),
      ],
      [10],
    );
    expect(analysis.sensitivity).toEqual([{ code: "a", milestoneDelta: { "10": { anticipate: -H, delay: null } } }]);
  });

  it("raises a pace alarm when the last five runs no longer get at least 5% faster", () => {
    const runsOf = (hours: number[]): RunRecord[] => {
      let t = 0;
      return hours.map((d, index) => {
        const startMs = t;
        t += d * H;
        return { index, startMs, endMs: t, gain: 10, ratePerHour: 10 / d };
      });
    };
    const flat = analyzeCalibration([make("ref", "reference", runsOf([5, 3, 3, 3.1, 2.95, 3, 2.9]))], []);
    const pace = flat.alarms.filter((a) => a.kind === "pace");
    expect(pace).toHaveLength(1);
    expect(pace[0]?.detail).toContain("il ritmo non accelera più");
    const accelerating = analyzeCalibration([make("ref", "reference", runsOf([5, 4, 3.5, 3, 2.5, 2]))], []);
    expect(accelerating.alarms.filter((a) => a.kind === "pace")).toEqual([]);
    const fewRuns = analyzeCalibration([make("ref", "reference", runsOf([3, 3, 3]))], []);
    expect(fewRuns.alarms.filter((a) => a.kind === "pace")).toEqual([]);
    // growth case takes precedence: one pace alarm only.
    const both = analyzeCalibration([make("ref", "reference", runsOf([2, 2.3, 2.6, 3, 3.5, 4]))], []);
    const bothPace = both.alarms.filter((a) => a.kind === "pace");
    expect(bothPace).toHaveLength(1);
    expect(bothPace[0]?.detail).toContain("rallenta");
  });

  it("raises a shape alarm when the gap grows with plateaus", () => {
    // median ~ constant 100; the order's log10 gap: 0,0,0.2,0.2,0.4,0.4 (rates 100,100,158.5,158.5,251.2,251.2)
    const plateau = make("rnd:p", "random", hourlyRuns([100, 100, 10 ** 2.2, 10 ** 2.2, 10 ** 2.4, 10 ** 2.4]));
    const analysis = analyzeCalibration([make("ref", "reference", constant(100)), make("rnd:1", "random", constant(100)), make("rnd:2", "random", constant(100)), plateau], []);
    expect(analysis.alarms.filter((a) => a.kind === "shape").map((a) => a.orderId)).toEqual(["rnd:p"]);
  });

  it("has no rate past the end of a truncated order and excludes it from the median", () => {
    const fast = make("rnd:fast", "random", hourlyRuns([100, 1000, 10000]), { endedAtMs: 3 * H });
    const series = rateSeries(fast, [0, H, 2 * H, 3 * H, 4 * H, 6 * H]);
    expect(series).toEqual([null, 2, 3, 4, null, null]);
    const analysis = analyzeCalibration([make("ref", "reference", constant(100)), make("rnd:1", "random", constant(100)), fast], []);
    // after 3 h only ref and rnd:1 count: median is exactly 2
    expect(analysis.median[4]).toBe(2);
    expect(analysis.median[6]).toBe(2);
    expect(analysis.gaps["rnd:fast"]?.slice(4)).toEqual([null, null, null]);
  });

  it("formats hours with one shared rounding", () => {
    expect(formatHours(5_400_000)).toBe("1,5 h");
    expect(formatHours(4_000_000)).toBe("1,11 h");
    expect(formatHours(null)).toBe("-");
    expect(formatHours(H, true)).toBe("+1 h");
  });

  it("throws a clear error without a reference result", () => {
    expect(() => analyzeCalibration([make("rnd:1", "random", constant(100))], [])).toThrow(/reference/);
  });

  it("summarizes the median run phases per run, marks sorted by time, outside the median excluded", () => {
    const run = (index: number, duration: number, marks: Record<string, number>): RunRecord => ({ index, startMs: 0, endMs: duration, gain: 1, ratePerHour: 1, marks });
    const analysis = analyzeCalibration(
      [
        make("ref", "reference", [run(1, 4 * H, { late: 3 * H, early: 1 * H }), run(2, 2 * H, { early: 0.5 * H })]),
        make("rnd:1", "random", [run(1, 6 * H, { late: 5 * H, early: 2 * H })]),
        make("rnd:2", "random", [run(1, 2 * H, { early: 3 * H })]),
        make("beam", "beam-best", [run(1, 100 * H, { early: 99 * H, late: 99 * H })]),
      ],
      [],
    );
    expect(analysis.phaseMarks).toEqual(["early", "late"]);
    expect(analysis.phases).toEqual([
      { run: 1, orders: 3, durationMs: 4 * H, marks: { early: 2 * H, late: 4 * H }, reached: { early: 3, late: 2 } },
      { run: 2, orders: 1, durationMs: 2 * H, marks: { early: 0.5 * H, late: null }, reached: { early: 1, late: 0 } },
    ]);
  });

  it("has no phases when no run records marks", () => {
    const analysis = analyzeCalibration([make("ref", "reference", constant(100))], []);
    expect(analysis.phaseMarks).toEqual([]);
    expect(analysis.phases).toEqual([]);
  });

  it("computes the first purchase per code: best, median, censored orders and never-bought codes", () => {
    const buys = (...p: [string, number][]) => p.map(([code, h]) => ({ code, level: 1, tSimMs: h * H }));
    const results = [
      make("ref", "reference", constant(100), { purchases: buys(["a", 2], ["b", 5]) }),
      make("rnd:1", "random", constant(100), { purchases: buys(["a", 4]) }),
      make("rnd:2", "random", constant(100), { purchases: buys(["a", 3], ["b", 6]) }),
      make("rnd:3", "random", constant(100), { purchases: [] }),
      make("beam", "beam-best", constant(100), { purchases: buys(["a", 1], ["b", 1.5]) }),
    ];
    const analysis = analyzeCalibration(results, []);
    // a: median origins 2, 4, 3, inf -> sorted 2, 3, 4, inf -> 3.5 h; best includes the beam.
    expect(analysis.firstPurchase["a"]).toEqual({ best: H, median: 3.5 * H });
    // b: 5, inf, 6, inf -> sorted 5, 6, inf, inf -> inf -> null.
    expect(analysis.firstPurchase["b"]).toEqual({ best: 1.5 * H, median: null });
    // c: in the orders, bought by nobody.
    expect(analysis.firstPurchase["c"]).toEqual({ best: null, median: null });
    expect(Object.keys(analysis.firstPurchase)).toEqual(["a", "b", "c"]);
    expect(JSON.stringify(analysis)).not.toMatch(/NaN|Infinity/);
  });
});
