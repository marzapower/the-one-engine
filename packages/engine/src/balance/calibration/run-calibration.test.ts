import { describe, expect, it } from "vitest";

import { isValidOrder } from "./orders";
import { type PresenceProfile, openMsUntil } from "./presence";
import { type CalibrationPlan, type OrderExecutor, runCalibration } from "./run-calibration";
import type { OrderJob, OrderResult, ShopEntry, ShopOrder } from "./types";

const SHOP: ShopEntry[] = [
  { code: "a", maxLevel: 2 },
  { code: "b", maxLevel: 1 },
  { code: "c", maxLevel: 2 },
  { code: "d", maxLevel: 1 },
];
const WEIGHT: Record<string, number> = { a: 5, b: 1, c: 8, d: 3 };
const REFERENCE: ShopOrder = [
  { code: "b", level: 1 },
  { code: "a", level: 1 },
  { code: "d", level: 1 },
  { code: "c", level: 1 },
  { code: "a", level: 2 },
  { code: "c", level: 2 },
];

const keyOf = (o: ShopOrder): string => o.map((i) => `${i.code}${i.level}`).join(",");

/** Additive cost: time to milestone "10" = sum of (position + 1) * weight(code), in ms. */
function simulate(job: OrderJob): OrderResult {
  const t = job.order.reduce((sum, item, i) => sum + (i + 1) * WEIGHT[item.code]! * 1000, 0);
  return {
    ...job,
    purchases: job.order.map((item, i) => ({ ...item, tSimMs: (i + 1) * 1000 })),
    runs: [{ index: 0, startMs: 0, endMs: t, gain: 10, ratePerHour: 100 + t / 1000 }],
    milestoneTimes: { "10": t },
    horizonMs: 7_200_000,
    endedAtMs: 7_200_000,
  };
}

function makeExecutor(batches: OrderJob[][] = []): OrderExecutor {
  return async (jobs) => {
    batches.push(jobs);
    return jobs.map(simulate);
  };
}

const plan = (extra: Partial<CalibrationPlan> = {}): CalibrationPlan => ({
  shop: SHOP,
  reference: REFERENCE,
  milestones: [10],
  seed: 7,
  ...extra,
});

describe("runCalibration", () => {
  it("first batch holds ref, ant:*, del:* and rnd:* with valid orders", async () => {
    const batches: OrderJob[][] = [];
    await runCalibration(plan(), makeExecutor(batches));
    const first = batches[0]!;
    const ids = first.map((j) => j.id);
    expect(ids).toContain("ref");
    expect(first.find((j) => j.id === "ref")!.origin).toBe("reference");
    for (const code of ["a", "b", "c", "d"]) {
      expect(first.find((j) => j.id === `ant:${code}`)?.origin ?? "anticipate").toBe("anticipate");
      expect(first.find((j) => j.id === `del:${code}`)?.origin ?? "delay").toBe("delay");
    }
    expect(ids.some((id) => id.startsWith("rnd:"))).toBe(true);
    for (const job of first) expect(isValidOrder(job.order)).toBe(true);
    expect(new Set(first.map((j) => keyOf(j.order))).size).toBe(first.length);
  });

  it("keeps ant/del identical to the reference as copies of its result", async () => {
    const result = await runCalibration(plan(), makeExecutor());
    // b is first in the reference: anticipating it changes nothing.
    const ant = result.results.find((r) => r.id === "ant:b")!;
    expect(ant.origin).toBe("anticipate");
    expect(ant.subject).toBe("b");
    expect(ant.milestoneTimes).toEqual(result.results.find((r) => r.id === "ref")!.milestoneTimes);
  });

  it("beam-best is the optimal order and beam-worst the worst", async () => {
    const result = await runCalibration(plan(), makeExecutor());
    const best = result.results.find((r) => r.id === "beam-best")!;
    const worst = result.results.find((r) => r.id === "beam-worst")!;
    expect(best.origin).toBe("beam-best");
    expect(worst.origin).toBe("beam-worst");
    expect(keyOf(best.order)).toBe("c1,c2,a1,a2,d1,b1");
    expect(keyOf(worst.order)).toBe("b1,d1,a1,a2,c1,c2");
    expect(result.truncated).toBe(false);
    expect(result.jobsRun).toBeLessThanOrEqual(result.maxJobs);
  });

  it("same seed gives identical results", async () => {
    const one = await runCalibration(plan(), makeExecutor());
    const two = await runCalibration(plan(), makeExecutor());
    expect(two).toEqual(one);
  });

  it("is independent from batch splitting and result order", async () => {
    const scattered: OrderExecutor = async (jobs) => {
      const out: OrderResult[] = [];
      for (let k = 0; k < 4; k++) {
        const chunk = jobs.filter((_, i) => i % 4 === k);
        if (chunk.length > 0) out.push(...(await makeExecutor()(chunk)));
      }
      return out.reverse();
    };
    const one = await runCalibration(plan(), makeExecutor());
    const two = await runCalibration(plan(), scattered);
    expect(two).toEqual(one);
  });

  it("beamWidth 0 skips the beam", async () => {
    const result = await runCalibration(plan({ beamWidth: 0 }), makeExecutor());
    expect(result.results.some((r) => r.origin === "beam-best")).toBe(false);
  });

  it("never exceeds maxJobs and flags truncation", async () => {
    const batches: OrderJob[][] = [];
    const result = await runCalibration(plan({ maxJobs: 8 }), makeExecutor(batches));
    expect(result.truncated).toBe(true);
    expect(result.jobsRun).toBeLessThanOrEqual(8);
    expect(batches.flat().length).toBe(result.jobsRun);
    expect(result.results.some((r) => r.id === "ref")).toBe(true);
  });
});

describe("runCalibration dedup and limits", () => {
  const shop2: ShopEntry[] = [
    { code: "a", maxLevel: 1 },
    { code: "b", maxLevel: 1 },
  ];
  const ref2: ShopOrder = [
    { code: "a", level: 1 },
    { code: "b", level: 1 },
  ];

  it("gives every ant/del job its own result even when it equals another job's order", async () => {
    const batches: OrderJob[][] = [];
    const result = await runCalibration({ shop: shop2, reference: ref2, milestones: [10], seed: 1, beamWidth: 0, randomCount: 0 }, makeExecutor(batches));
    // [a,b]: ant:a = ref, del:b = ref, ant:b = del:a = [b,a]
    const ids = result.results.map((r) => r.id).sort();
    expect(ids).toEqual(["ant:a", "ant:b", "del:a", "del:b", "ref"]);
    const antB = result.results.find((r) => r.id === "ant:b")!;
    const delA = result.results.find((r) => r.id === "del:a")!;
    expect(antB.subject).toBe("b");
    expect(delA.subject).toBe("a");
    expect(antB.origin).toBe("anticipate");
    expect(delA.origin).toBe("delay");
    expect(antB.milestoneTimes).toEqual(delA.milestoneTimes);
    expect(batches.flat()).toHaveLength(2);
  });

  it("rejects maxJobs < 1", async () => {
    await expect(runCalibration(plan({ maxJobs: 0 }), makeExecutor())).rejects.toThrow(/maxJobs/);
  });

  it("with a presence, returns open-time results", async () => {
    const H = 3_600_000;
    // Open the first hour of every two: calendar time t maps to openMsUntil(t).
    const presence: PresenceProfile = { periodMs: 2 * H, sessions: [{ startMs: 0, durationMs: H, visits: [{ forMs: 60_000, everyMs: 60_000 }] }] };
    const plain = await runCalibration(plan(), makeExecutor());
    const open = await runCalibration(plan({ presence }), makeExecutor());

    const ref = (run: typeof plain) => run.results.find((r) => r.id === "ref")!;
    const calendar = simulate({ id: "ref", origin: "reference", order: REFERENCE });
    expect(ref(plain).milestoneTimes["10"]).toBe(calendar.milestoneTimes["10"]);
    expect(ref(open).milestoneTimes["10"]).toBe(openMsUntil(presence, calendar.milestoneTimes["10"]!));
    expect(ref(open).horizonMs).toBe(openMsUntil(presence, calendar.horizonMs));
    expect(ref(open).runs[0]!.endMs).toBe(openMsUntil(presence, calendar.runs[0]!.endMs));
    expect(ref(open).purchases[0]!.tSimMs).toBe(openMsUntil(presence, calendar.purchases[0]!.tSimMs));
  });
});
