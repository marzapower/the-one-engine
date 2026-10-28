import { describe, expect, it } from "vitest";

import { type PresenceProfile, canTapAt, isOpen, isVisit, openMsUntil, toOpenTime, validatePresence } from "./presence";
import type { OrderResult } from "./types";

const MIN = 60_000;
const H = 60 * MIN;

/** The shape of The One's player: two 2.5 h sessions a day (at 0 h and 12 h), 30 min every 2 min, then every 15 min. */
const SESSION = [
  { forMs: 30 * MIN, everyMs: 2 * MIN },
  { forMs: 120 * MIN, everyMs: 15 * MIN },
];
const THE_ONE: PresenceProfile = {
  periodMs: 24 * H,
  sessions: [
    { startMs: 0, durationMs: 150 * MIN, visits: SESSION },
    { startMs: 12 * H, durationMs: 150 * MIN, visits: SESSION },
  ],
};

describe("validatePresence", () => {
  it("accepts the The One shape", () => {
    expect(() => validatePresence(THE_ONE)).not.toThrow();
  });

  const one = (over: Partial<PresenceProfile["sessions"][number]> = {}, period = 10 * H): PresenceProfile => ({
    periodMs: period,
    sessions: [
      {
        startMs: 0,
        durationMs: H,
        visits: [
          { forMs: 30 * MIN, everyMs: 5 * MIN },
          { forMs: H, everyMs: 10 * MIN },
        ],
        ...over,
      },
    ],
  });

  it("rejects overlapping or unsorted sessions", () => {
    const profile: PresenceProfile = {
      periodMs: 10 * H,
      sessions: [
        { startMs: 0, durationMs: 2 * H, visits: [{ forMs: H, everyMs: MIN }] },
        { startMs: H, durationMs: H, visits: [{ forMs: H, everyMs: MIN }] },
      ],
    };
    expect(() => validatePresence(profile)).toThrow(/overlap/);
  });

  it("rejects values that are not a multiple of a minute", () => {
    expect(() => validatePresence(one({ durationMs: H + 1000 }))).toThrow(/durationMs/);
    expect(() => validatePresence(one({ startMs: 30_000 }))).toThrow(/startMs/);
    expect(() =>
      validatePresence(
        one({
          visits: [
            { forMs: 90_000, everyMs: MIN },
            { forMs: H, everyMs: MIN },
          ],
        }),
      ),
    ).toThrow(/forMs/);
    expect(() => validatePresence(one({ visits: [{ forMs: MIN, everyMs: 90_000 }] }))).toThrow(/everyMs/);
    expect(() => validatePresence(one({}, 10 * H + 1))).toThrow(/periodMs/);
  });

  it("rejects a session outside the period", () => {
    expect(() => validatePresence(one({ startMs: 9.5 * H }))).toThrow(/outside presence.periodMs/);
  });

  it("rejects non-positive values", () => {
    expect(() => validatePresence(one({ durationMs: 0 }))).toThrow(/durationMs/);
    expect(() => validatePresence(one({ visits: [{ forMs: MIN, everyMs: 0 }] }))).toThrow(/everyMs/);
  });

  it("rejects a session with no phases or no sessions", () => {
    expect(() => validatePresence(one({ visits: [] }))).toThrow(/visits/);
    expect(() => validatePresence({ periodMs: H, sessions: [] })).toThrow(/sessions/);
  });

  it("rejects phases before the last that fill the whole session", () => {
    expect(() =>
      validatePresence(
        one({
          visits: [
            { forMs: H, everyMs: MIN },
            { forMs: MIN, everyMs: MIN },
          ],
        }),
      ),
    ).toThrow(/less than durationMs/);
  });
});

describe("isOpen / isVisit over two days of the The One shape", () => {
  it("is open exactly inside the two daily sessions", () => {
    for (const day of [0, 1]) {
      const base = day * 24 * H;
      expect(isOpen(THE_ONE, base)).toBe(true);
      expect(isOpen(THE_ONE, base + 150 * MIN - 1)).toBe(true);
      expect(isOpen(THE_ONE, base + 150 * MIN)).toBe(false);
      expect(isOpen(THE_ONE, base + 11 * H)).toBe(false);
      expect(isOpen(THE_ONE, base + 12 * H)).toBe(true);
      expect(isOpen(THE_ONE, base + 12 * H + 149 * MIN)).toBe(true);
      expect(isOpen(THE_ONE, base + 12 * H + 150 * MIN)).toBe(false);
      expect(isOpen(THE_ONE, base + 23 * H)).toBe(false);
    }
    expect(isOpen(THE_ONE, -MIN)).toBe(false);
  });

  it("visits every 2 minutes for 30 minutes, then every 15 until the end, and never when closed", () => {
    for (const base of [0, 12 * H, 24 * H, 36 * H]) {
      expect(isVisit(THE_ONE, base)).toBe(true); // the session start
      expect(isVisit(THE_ONE, base + MIN)).toBe(false);
      expect(isVisit(THE_ONE, base + 2 * MIN)).toBe(true);
      expect(isVisit(THE_ONE, base + 28 * MIN)).toBe(true);
      expect(isVisit(THE_ONE, base + 30 * MIN)).toBe(true); // second phase starts: its first visit
      expect(isVisit(THE_ONE, base + 32 * MIN)).toBe(false);
      expect(isVisit(THE_ONE, base + 44 * MIN)).toBe(false);
      expect(isVisit(THE_ONE, base + 45 * MIN)).toBe(true);
      expect(isVisit(THE_ONE, base + 60 * MIN)).toBe(true);
      expect(isVisit(THE_ONE, base + 150 * MIN - 15 * MIN)).toBe(true);
      expect(isVisit(THE_ONE, base + 150 * MIN)).toBe(false); // closed
      expect(isVisit(THE_ONE, base + 3 * H)).toBe(false);
    }
  });

  it("a phase boundary that is not a multiple of the next rhythm restarts the rhythm at the boundary", () => {
    const profile: PresenceProfile = {
      periodMs: H,
      sessions: [
        {
          startMs: 0,
          durationMs: 40 * MIN,
          visits: [
            { forMs: 5 * MIN, everyMs: 2 * MIN },
            { forMs: 10 * MIN, everyMs: 10 * MIN },
          ],
        },
      ],
    };
    const visits = Array.from({ length: 40 }, (_, m) => m).filter((m) => isVisit(profile, m * MIN));
    expect(visits).toEqual([0, 2, 4, 5, 15, 25, 35]);
  });
});

describe("openMsUntil", () => {
  it("counts the open time in [0, t)", () => {
    expect(openMsUntil(THE_ONE, 0)).toBe(0);
    expect(openMsUntil(THE_ONE, 100 * MIN)).toBe(100 * MIN);
    expect(openMsUntil(THE_ONE, 150 * MIN)).toBe(150 * MIN);
    expect(openMsUntil(THE_ONE, 10 * H)).toBe(150 * MIN);
    expect(openMsUntil(THE_ONE, 12 * H + 30 * MIN)).toBe(150 * MIN + 30 * MIN);
    expect(openMsUntil(THE_ONE, 24 * H)).toBe(300 * MIN);
    expect(openMsUntil(THE_ONE, 48 * H + 10 * MIN)).toBe(600 * MIN + 10 * MIN);
    expect(openMsUntil(THE_ONE, 10 * 24 * H)).toBe(10 * 300 * MIN);
  });
});

describe("toOpenTime", () => {
  const profile: PresenceProfile = { periodMs: 10 * H, sessions: [{ startMs: 0, durationMs: 2 * H, visits: [{ forMs: H, everyMs: MIN }] }] };
  const result: OrderResult = {
    id: "x",
    origin: "reference",
    order: [{ code: "a", level: 1 }],
    purchases: [{ code: "a", level: 1, tSimMs: 11 * H }],
    runs: [
      { index: 1, startMs: 0, endMs: 11 * H, gain: 22, ratePerHour: 2, marks: { A: 30 * MIN, B: 11 * H } },
      { index: 2, startMs: 11 * H, endMs: 11 * H, gain: 1, ratePerHour: 0 },
    ],
    milestoneTimes: { "10": 21 * H, "100": null },
    horizonMs: 30 * H,
    endedAtMs: 20 * H,
    openRun: { startMs: 11 * H, marks: { C: 30 * MIN } },
  };

  it("maps every instant to open time and recomputes the rate", () => {
    const frozen = structuredClone(result);
    const converted = toOpenTime(result, profile);
    expect(result).toEqual(frozen); // not mutated

    expect(converted.purchases[0]!.tSimMs).toBe(3 * H); // 11 h = 2 h open + 1 h of the next period
    expect(converted.runs[0]).toMatchObject({ startMs: 0, endMs: 3 * H, gain: 22 });
    expect(converted.runs[0]!.ratePerHour).toBeCloseTo(22 / 3, 10);
    expect(converted.runs[0]!.marks).toEqual({ A: 30 * MIN, B: 3 * H });
    expect(converted.runs[1]).toMatchObject({ startMs: 3 * H, endMs: 3 * H, ratePerHour: 0 });
    expect(converted.runs[1]!.marks).toBeUndefined();
    expect(converted.milestoneTimes).toEqual({ "10": 5 * H, "100": null });
    expect(converted.horizonMs).toBe(6 * H);
    expect(converted.endedAtMs).toBe(4 * H);
    expect(converted.openRun).toEqual({ startMs: 3 * H, marks: { C: 30 * MIN } });
  });

  it("leaves a result without openRun without it", () => {
    const { openRun: _openRun, ...bare } = result;
    expect("openRun" in toOpenTime(bare, profile)).toBe(false);
  });
});

describe("canTapAt", () => {
  it("taps in the minute ending on a visit or right after it, never in the closed minute before a session", () => {
    // The One shape: a session at 12 h opens with a visit every 2 minutes.
    expect(canTapAt(THE_ONE, 12 * H)).toBe(false);
    expect(canTapAt(THE_ONE, 12 * H + MIN)).toBe(true);
    expect(canTapAt(THE_ONE, 12 * H + 2 * MIN)).toBe(true);
    // In the 15-minute part, the minute after a visit taps, the next one does not.
    expect(canTapAt(THE_ONE, 12 * H + 45 * MIN)).toBe(true);
    expect(canTapAt(THE_ONE, 12 * H + 46 * MIN)).toBe(true);
    expect(canTapAt(THE_ONE, 12 * H + 47 * MIN)).toBe(false);
    expect(canTapAt(THE_ONE, 6 * H)).toBe(false);
  });
});
