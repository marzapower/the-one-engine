import type { OrderResult } from "./types";

/**
 * A player's presence: when the page is open and how often the player acts.
 * Generic (no game content). Everything is in simulated milliseconds and on
 * the one-minute grid of the calibration sampling.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Consecutive visit rhythms inside a session; the last one lasts until the session ends. */
export interface VisitPhase {
  forMs: number;
  everyMs: number;
}
export interface PresenceSession {
  startMs: number;
  durationMs: number;
  visits: VisitPhase[];
}
/** When the page is open, repeating every `periodMs` from t = 0. */
export interface PresenceProfile {
  periodMs: number;
  sessions: PresenceSession[];
}

const isMinuteMultiple = (value: number): boolean => Number.isInteger(value) && value % MINUTE_MS === 0;

/** Throws (English message naming the field) unless the profile is well formed. */
export function validatePresence(profile: PresenceProfile): void {
  if (!(profile.periodMs > 0) || !isMinuteMultiple(profile.periodMs)) {
    throw new Error(`presence.periodMs must be a positive multiple of ${MINUTE_MS} ms, got ${profile.periodMs}`);
  }
  if (profile.sessions.length === 0) throw new Error("presence.sessions must hold at least one session");

  let previousEnd = 0;
  profile.sessions.forEach((session, s) => {
    const at = `presence.sessions[${s}]`;
    if (!(session.startMs >= 0) || !isMinuteMultiple(session.startMs)) {
      throw new Error(`${at}.startMs must be a non-negative multiple of ${MINUTE_MS} ms, got ${session.startMs}`);
    }
    if (!(session.durationMs > 0) || !isMinuteMultiple(session.durationMs)) {
      throw new Error(`${at}.durationMs must be a positive multiple of ${MINUTE_MS} ms, got ${session.durationMs}`);
    }
    if (session.startMs < previousEnd) {
      throw new Error(`${at}.startMs overlaps the previous session (sessions must be sorted and not overlap), got ${session.startMs}`);
    }
    const end = session.startMs + session.durationMs;
    if (end > profile.periodMs) throw new Error(`${at} ends at ${end}, outside presence.periodMs (${profile.periodMs})`);
    previousEnd = end;

    if (session.visits.length === 0) throw new Error(`${at}.visits must hold at least one phase`);
    let phasesBeforeLast = 0;
    session.visits.forEach((phase, p) => {
      const phaseAt = `${at}.visits[${p}]`;
      if (!(phase.forMs > 0) || !isMinuteMultiple(phase.forMs)) {
        throw new Error(`${phaseAt}.forMs must be a positive multiple of ${MINUTE_MS} ms, got ${phase.forMs}`);
      }
      if (!(phase.everyMs > 0) || !isMinuteMultiple(phase.everyMs)) {
        throw new Error(`${phaseAt}.everyMs must be a positive multiple of ${MINUTE_MS} ms, got ${phase.everyMs}`);
      }
      if (p < session.visits.length - 1) phasesBeforeLast += phase.forMs;
    });
    if (phasesBeforeLast >= session.durationMs) {
      throw new Error(`${at}.visits: the forMs of the phases before the last add up to ${phasesBeforeLast}, which must be less than durationMs (${session.durationMs})`);
    }
  });
}

/** Offset of tMs inside the period (also for negative times). */
const offsetIn = (profile: PresenceProfile, tMs: number): number => ((tMs % profile.periodMs) + profile.periodMs) % profile.periodMs;

/** The page is open at tMs: some session s with s.startMs ≤ (tMs mod periodMs) < s.startMs + s.durationMs. */
export function isOpen(profile: PresenceProfile, tMs: number): boolean {
  return sessionAt(profile, tMs) !== undefined;
}

/** The session open at tMs, with tMs relative to its start. */
function sessionAt(profile: PresenceProfile, tMs: number): { session: PresenceSession; rel: number } | undefined {
  if (tMs < 0) return undefined;
  const offset = offsetIn(profile, tMs);
  const session = profile.sessions.find((s) => offset >= s.startMs && offset < s.startMs + s.durationMs);
  return session && { session, rel: offset - session.startMs };
}

/** A visit falls exactly on tMs: open, and tMs = session start + phase start + k·everyMs inside its phase (the last phase runs to the session end). */
export function isVisit(profile: PresenceProfile, tMs: number): boolean {
  const at = sessionAt(profile, tMs);
  if (!at) return false;
  const { session, rel } = at;
  let phaseStart = 0;
  for (let p = 0; p < session.visits.length; p++) {
    const phase = session.visits[p]!;
    const last = p === session.visits.length - 1;
    if (last || rel < phaseStart + phase.forMs) return (rel - phaseStart) % phase.everyMs === 0;
    phaseStart += phase.forMs;
  }
  return false;
}

/**
 * Whether the player taps in the sampling minute that ends at tMs: the minute
 * is open and holds a visit at its end or at its start (the player taps to
 * restart right after a visit; the harness taps before deciding).
 */
export function canTapAt(profile: PresenceProfile, tMs: number): boolean {
  return isOpen(profile, tMs - MINUTE_MS) && (isVisit(profile, tMs) || isVisit(profile, tMs - MINUTE_MS));
}

/** Total open time in [0, tMs). */
export function openMsUntil(profile: PresenceProfile, tMs: number): number {
  if (!(tMs > 0)) return 0;
  const periods = Math.floor(tMs / profile.periodMs);
  const offset = tMs - periods * profile.periodMs;
  let perPeriod = 0;
  let partial = 0;
  for (const s of profile.sessions) {
    perPeriod += s.durationMs;
    partial += Math.max(0, Math.min(offset, s.startMs + s.durationMs) - s.startMs);
  }
  return periods * perPeriod + partial;
}

/** The same result with every instant mapped to open time (openMsUntil): runs (ratePerHour recomputed on open time), marks (open time from the run start), purchases, milestones, endedAtMs, horizonMs, openRun. Does not mutate the input. */
export function toOpenTime(result: OrderResult, profile: PresenceProfile): OrderResult {
  const open = (tMs: number): number => openMsUntil(profile, tMs);
  const marksOf = (startMs: number, marks: Record<string, number>): Record<string, number> => {
    const converted: Record<string, number> = {};
    for (const [label, ms] of Object.entries(marks)) converted[label] = open(startMs + ms) - open(startMs);
    return converted;
  };

  return {
    ...result,
    purchases: result.purchases.map((p) => ({ ...p, tSimMs: open(p.tSimMs) })),
    runs: result.runs.map((run) => {
      const startMs = open(run.startMs);
      const endMs = open(run.endMs);
      const durationMs = endMs - startMs;
      const { marks, ...rest } = run;
      return {
        ...rest,
        startMs,
        endMs,
        ratePerHour: durationMs > 0 ? run.gain / (durationMs / HOUR_MS) : 0,
        ...(marks && { marks: marksOf(run.startMs, marks) }),
      };
    }),
    milestoneTimes: Object.fromEntries(Object.entries(result.milestoneTimes).map(([key, t]) => [key, t === null ? null : open(t)])),
    horizonMs: open(result.horizonMs),
    endedAtMs: open(result.endedAtMs),
    ...(result.openRun && { openRun: { startMs: open(result.openRun.startMs), marks: marksOf(result.openRun.startMs, result.openRun.marks) } }),
  };
}
