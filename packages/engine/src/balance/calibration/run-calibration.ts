/**
 * Calibration orchestrator: batch 1 (reference, perturbations, random orders)
 * and a beam search for the best and worst complete orders, then the analysis.
 * Generic: the simulation is delegated to an injected executor. Results are
 * re-aligned by job id, so they do not depend on batching or return order.
 */
import { type CalibrationAnalysis, analyzeCalibration } from "./analyze";
import { anticipate, delay, keyOf, randomOrders } from "./orders";
import { type PresenceProfile, toOpenTime } from "./presence";
import type { CalibrationThresholds, OrderItem, OrderJob, OrderResult, ShopEntry, ShopOrder } from "./types";

export type OrderExecutor = (jobs: OrderJob[]) => Promise<OrderResult[]>;

export interface CalibrationPlan {
  shop: ShopEntry[];
  /** Computed by the consumer with `referenceOrder`. */
  reference: ShopOrder;
  milestones: number[];
  /** Default 24. */
  randomCount?: number;
  seed: number;
  /** Default 2; 0 disables the beam search. */
  beamWidth?: number;
  /** Cap on the total simulated jobs. Default 400. */
  maxJobs?: number;
  thresholds?: Partial<CalibrationThresholds>;
  /** The player's presence: results are converted to open time (`toOpenTime`) before scoring and analysis. */
  presence?: PresenceProfile;
}

export type CalibrationRun = CalibrationAnalysis & { jobsRun: number; maxJobs: number; truncated: boolean };

interface Candidate {
  prefix: ShopOrder;
  order: ShopOrder;
  key: string;
  score: number;
}

export async function runCalibration(plan: CalibrationPlan, execute: OrderExecutor): Promise<CalibrationRun> {
  const randomCount = plan.randomCount ?? 24;
  const beamWidth = plan.beamWidth ?? 2;
  const maxJobs = plan.maxJobs ?? 400;
  if (maxJobs < 1) throw new Error(`runCalibration: maxJobs must be at least 1 (the reference is always simulated), got ${maxJobs}`);
  const milestoneKeys = plan.milestones.map(String);

  let jobsRun = 0;
  let truncated = false;
  /** Simulated results by order key. */
  const cache = new Map<string, OrderResult>();

  /** Simulates the jobs (all distinct and not cached), within the remaining budget. */
  async function simulate(jobs: OrderJob[]): Promise<void> {
    const room = Math.max(0, maxJobs - jobsRun);
    let todo = jobs;
    if (todo.length > room) {
      truncated = true;
      todo = todo.slice(0, room);
    }
    if (todo.length === 0) return;
    const returned = await execute(todo);
    jobsRun += todo.length;
    const byId = new Map(returned.map((r) => [r.id, r]));
    for (const job of todo) {
      const result = byId.get(job.id);
      if (!result) throw new Error(`runCalibration: the executor returned no result for job '${job.id}'`);
      const own = plan.presence ? toOpenTime(result, plan.presence) : result;
      cache.set(keyOf(job.order), { ...own, id: job.id, origin: job.origin, subject: job.subject, order: job.order });
    }
  }

  // Batch 1: reference first, so it survives a tight budget.
  const lot: OrderJob[] = [{ id: "ref", origin: "reference", order: plan.reference }];
  for (const { code } of plan.shop) lot.push({ id: `ant:${code}`, origin: "anticipate", subject: code, order: anticipate(plan.reference, code) });
  for (const { code } of plan.shop) lot.push({ id: `del:${code}`, origin: "delay", subject: code, order: delay(plan.reference, code) });
  randomOrders(plan.shop, randomCount, plan.seed).forEach((order, n) => lot.push({ id: `rnd:${n}`, origin: "random", order }));

  // One simulation per distinct order; every ant/del job gets its own copy of the result of its key.
  const seen = new Set<string>();
  const toRun: OrderJob[] = [];
  const refKey = keyOf(plan.reference);
  for (const job of lot) {
    const key = keyOf(job.order);
    if (seen.has(key)) continue;
    seen.add(key);
    toRun.push(job);
  }
  await simulate(toRun);

  const results: OrderResult[] = [];
  const reference = cache.get(refKey);
  for (const job of lot) {
    const hit = cache.get(keyOf(job.order));
    if (!hit) continue; // cut by the budget
    if (hit.id === job.id) results.push(hit);
    else if (job.origin === "anticipate" || job.origin === "delay") results.push({ ...hit, id: job.id, origin: job.origin, subject: job.subject, order: job.order });
  }

  // Beam search.
  if (beamWidth > 0 && reference) {
    // Score: time to the highest milestone the reference reaches; failing that, the first milestone anyone reaches.
    let scoreKey: string | undefined;
    for (const k of milestoneKeys) if (reference.milestoneTimes[k] !== null && reference.milestoneTimes[k] !== undefined) scoreKey = k;
    if (scoreKey === undefined) {
      for (const k of milestoneKeys) {
        if ([...cache.values()].some((r) => r.milestoneTimes[k] !== null && r.milestoneTimes[k] !== undefined)) {
          scoreKey = k;
          break;
        }
      }
    }
    const scoreOf = (result: OrderResult): number => {
      const t = scoreKey === undefined ? null : result.milestoneTimes[scoreKey];
      return t === null || t === undefined ? Infinity : t;
    };
    const byKey = (a: Candidate, b: Candidate): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const asc = (a: Candidate, b: Candidate): number => (a.score === b.score ? byKey(a, b) : a.score < b.score ? -1 : 1);
    const desc = (a: Candidate, b: Candidate): number => (a.score === b.score ? byKey(a, b) : a.score > b.score ? -1 : 1);

    const evaluated = new Map<string, Candidate>();
    let beamId = 0;
    let kept: ShopOrder[] = [[]];
    const total = plan.reference.length;

    for (let level = 1; level <= total && !truncated; level++) {
      // Candidates: each kept prefix plus one valid next item, completed in reference order.
      const candidates = new Map<string, { prefix: ShopOrder; order: ShopOrder; key: string }>();
      for (const prefix of kept) {
        const used = new Set(prefix.map((i) => `${i.code}:${i.level}`));
        const nextLevel = new Map<string, number>();
        for (const i of prefix) nextLevel.set(i.code, i.level + 1);
        const options: OrderItem[] = [];
        for (const { code } of plan.shop) {
          const item = { code, level: nextLevel.get(code) ?? 1 };
          if (plan.reference.some((r) => r.code === item.code && r.level === item.level)) options.push(item);
        }
        for (const item of options) {
          const next = [...prefix, item];
          const nextUsed = new Set([...used, `${item.code}:${item.level}`]);
          const order = [...next, ...plan.reference.filter((r) => !nextUsed.has(`${r.code}:${r.level}`))];
          const prefixKey = keyOf(next);
          if (!candidates.has(prefixKey)) candidates.set(prefixKey, { prefix: next, order, key: keyOf(order) });
        }
      }
      const list = [...candidates.values()];
      const fresh = new Map<string, OrderJob>();
      for (const c of list) {
        if (cache.has(c.key) || fresh.has(c.key)) continue;
        fresh.set(c.key, { id: `bm:${beamId++}`, origin: "random", order: c.order });
      }
      await simulate([...fresh.values()]);

      const scored: Candidate[] = [];
      for (const c of list) {
        const hit = cache.get(c.key);
        if (!hit) continue; // cut by the budget
        const cand = { ...c, score: scoreOf(hit) };
        scored.push(cand);
        evaluated.set(c.key, cand);
      }
      if (scored.length === 0) break;
      const best = [...scored].sort(asc).slice(0, beamWidth);
      const worst = [...scored].sort(desc).slice(0, beamWidth);
      const next = new Map<string, ShopOrder>();
      for (const c of [...best, ...worst]) next.set(keyOf(c.prefix), c.prefix);
      kept = [...next.values()];
    }

    const all = [...evaluated.values()];
    if (all.length > 0) {
      const bestC = [...all].sort(asc)[0]!;
      const worstC = [...all].sort(desc)[0]!;
      const bestR = cache.get(bestC.key)!;
      const worstR = cache.get(worstC.key)!;
      results.push({ ...bestR, id: "beam-best", origin: "beam-best", subject: undefined, order: bestC.order });
      results.push({ ...worstR, id: "beam-worst", origin: "beam-worst", subject: undefined, order: worstC.order });
    }
  }

  const analysis = analyzeCalibration(results, plan.milestones, plan.thresholds);
  return { ...analysis, jobsRun, maxJobs, truncated };
}
