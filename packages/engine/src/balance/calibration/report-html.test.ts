import { describe, expect, it } from "vitest";

import { analyzeCalibration } from "./analyze";
import { renderCalibrationHtml } from "./report-html";
import type { OrderItem, OrderOrigin, OrderResult, RunRecord } from "./types";

const H = 3_600_000;

const order = (...codes: string[]): OrderItem[] => codes.map((code) => ({ code, level: 1 }));

function hourlyRuns(rates: number[]): RunRecord[] {
  return rates.map((ratePerHour, i) => ({ index: i, startMs: i * H, endMs: (i + 1) * H, gain: ratePerHour, ratePerHour }));
}

function make(id: string, origin: OrderOrigin, runs: RunRecord[], extra: Partial<OrderResult> = {}): OrderResult {
  return { id, origin, order: order("a", "b", "c"), purchases: [], runs, milestoneTimes: {}, horizonMs: 6 * H, endedAtMs: 6 * H, ...extra };
}

const constant = (rate: number) => hourlyRuns([rate, rate, rate, rate, rate, rate]);
const meta = { title: "Prova", generatedAt: "2026-10-27T10:00:00Z" };

function alarmed() {
  const fast = make("rnd:fast", "random", hourlyRuns([100, 200, 400, 800, 1600, 3200]), { order: order("b", "a", "c"), milestoneTimes: { "10": null } });
  return analyzeCalibration(
    [
      make("ref", "reference", constant(100), { milestoneTimes: { "10": 2 * H } }),
      make("rnd:1", "random", constant(105), { milestoneTimes: { "10": 3 * H } }),
      make("rnd:2", "random", constant(95), { milestoneTimes: { "10": 3 * H } }),
      make("ant:a", "anticipate", constant(100), { subject: "a", milestoneTimes: { "10": 1 * H } }),
      make("del:a", "delay", constant(100), { subject: "a", milestoneTimes: { "10": null } }),
      fast,
    ],
    [10],
  );
}

describe("renderCalibrationHtml", () => {
  it("renders a standalone page with chart, alarmed order and provisional threshold", () => {
    const html = renderCalibrationHtml(alarmed(), { ...meta, provenance: { engine: "abc123" }, maxJobs: 50 });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<svg");
    expect(html).toContain("rnd:fast");
    expect(html).toContain("provvisorio");
    expect(html).toContain("oltre l'orizzonte");
    expect(html).toContain("abc123");
    expect(html).toContain("guadagno continuo");
    expect(html).not.toMatch(/NaN|Infinity/);
    expect(html).not.toContain("http");
  });

  it("states that copies of the reference count in the median as distinct orders", () => {
    const html = renderCalibrationHtml(alarmed(), meta);
    expect(html).toMatch(/copie del riferimento/);
  });

  it("is generated for an analysis with no runs and says no order prestiged", () => {
    const analysis = analyzeCalibration([make("ref", "reference", []), make("rnd:1", "random", [])], [10]);
    const html = renderCalibrationHtml(analysis, meta);
    expect(html).toMatch(/Nessun ordine ha prestigiato/);
    expect(html).not.toMatch(/NaN|Infinity/);
    expect(html).not.toContain("http");
  });

  it("escapes texts", () => {
    const analysis = analyzeCalibration([make("ref", "reference", constant(100), { order: order("<script>alert(1)</script>") })], []);
    const html = renderCalibrationHtml(analysis, { ...meta, title: "<b>x</b>", provenance: { "<i>": "<script>" } });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows the run phases only when the runs record marks", () => {
    expect(renderCalibrationHtml(alarmed(), meta)).not.toContain("Fasi della run");
    const runs: RunRecord[] = [
      { index: 1, startMs: 0, endMs: 2 * H, gain: 1, ratePerHour: 0.5, marks: { "Carry 1": H } },
      { index: 2, startMs: 2 * H, endMs: 3 * H, gain: 1, ratePerHour: 1, marks: {} },
    ];
    const html = renderCalibrationHtml(analyzeCalibration([make("ref", "reference", runs)], []), meta);
    expect(html).toContain("Fasi della run");
    expect(html).toContain("<th>Carry 1</th>");
    expect(html).toContain("<td>1 h</td>");
  });

  it("labels the times as active play with openTime, and not without", () => {
    const withOpen = renderCalibrationHtml(alarmed(), { ...meta, openTime: true });
    expect(withOpen).toContain("ore di gioco attivo");
    expect(withOpen).toContain("I tempi sono ore di gioco attivo: contano solo i momenti con la pagina aperta.");
    expect(withOpen).not.toContain("ore di gioco simulato");
    const without = renderCalibrationHtml(alarmed(), meta);
    expect(without).toContain("ore di gioco simulato");
    expect(without).not.toContain("gioco attivo");
  });

  it("shows the first purchase table, with 'mai' for upgrades nobody buys", () => {
    const analysis = analyzeCalibration(
      [
        make("ref", "reference", constant(100), { purchases: [{ code: "a", level: 1, tSimMs: 2 * H }] }),
        make("rnd:1", "random", constant(100), { purchases: [{ code: "a", level: 1, tSimMs: 4 * H }] }),
      ],
      [],
    );
    const html = renderCalibrationHtml(analysis, meta);
    expect(html).toContain("Primo acquisto");
    expect(html).toContain("<th>Upgrade</th><th>Migliore</th><th>Mediana</th>");
    expect(html).toContain("<td>2 h</td><td>3 h</td>");
    expect(html).toMatch(/<td><code>b<\/code><\/td><td>mai<\/td><td>mai<\/td>/);
    expect(html).not.toMatch(/NaN|Infinity/);
  });
});
