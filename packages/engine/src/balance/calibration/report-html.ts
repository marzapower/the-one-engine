/**
 * Standalone HTML report of a calibration analysis (design:
 * docs/superpowers/specs/2026-10-27-calibrazione-design.md). Pure and generic:
 * one self-contained page (inline CSS and SVG, no external resource), Italian
 * text, light theme. Never prints NaN or Infinity: missing values show as "-".
 */
import { type Alarm, type CalibrationAnalysis, formatHours as hours, rateSeries } from "./analyze";
import type { OrderItem, OrderOrigin, OrderResult } from "./types";

export interface CalibrationReportMeta {
  title: string;
  generatedAt: string;
  provenance?: Record<string, string>;
  maxJobs?: number;
  /** The times are hours of active play (open page) rather than simulated calendar hours. */
  openTime?: boolean;
}

const HOUR_MS = 3_600_000;

const escapeHtml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Colours with enough contrast on a white background. */
const ORIGIN_COLOR: Record<OrderOrigin, string> = {
  reference: "#1d4ed8",
  anticipate: "#047857",
  delay: "#b45309",
  random: "#6b7280",
  "beam-best": "#0e7490",
  "beam-worst": "#7c3aed",
};
const ORIGIN_LABEL: Record<OrderOrigin, string> = {
  reference: "riferimento",
  anticipate: "anticipato",
  delay: "ritardato",
  random: "casuale",
  "beam-best": "ricerca: migliore",
  "beam-worst": "ricerca: peggiore",
};
const ALARM_COLOR = "#dc2626";
const MEDIAN_COLOR = "#111827";

const KIND_LABEL: Record<Alarm["kind"], string> = { shape: "forma", shift: "spostamento", pace: "ritmo" };

const finite = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

function ratio(value: number | null): string {
  return finite(value) ? String(Math.round(value * 100) / 100) : "-";
}

const itemLabel = (item: OrderItem): string => (item.level > 1 ? `${item.code}#${item.level}` : item.code);

/** The order as a compact string; level 1 is implicit, higher levels show as `code#n`. */
function compactOrder(order: OrderItem[]): string {
  return order.map(itemLabel).join(" ");
}

const W = 960;
const H = 420;
const M = { left: 56, right: 16, top: 12, bottom: 40 };

function niceHourStep(maxHours: number): number {
  for (const step of [1, 2, 5, 10, 12, 24, 48]) if (maxHours / step <= 12) return step;
  return 96;
}

function renderChart(analysis: CalibrationAnalysis, openTime: boolean): string {
  const { grid, results, median, alarms } = analysis;
  const series = results.map((r) => ({ r, values: rateSeries(r, grid) }));
  const all: number[] = [];
  for (const s of series) for (const v of s.values) if (v !== null) all.push(v);
  for (const v of median) if (finite(v)) all.push(v);
  if (all.length === 0 || grid.length < 2) {
    return `<p class="empty">Nessun ordine ha prestigiato entro l'orizzonte: il grafico non ha dati da mostrare.</p>`;
  }
  const lo = Math.floor(Math.min(...all) - 0.1);
  const hi = Math.ceil(Math.max(...all) + 0.1);
  const span = Math.max(hi - lo, 1);
  const tMax = grid[grid.length - 1] ?? 1;
  const x = (t: number) => M.left + ((W - M.left - M.right) * t) / (tMax || 1);
  const y = (v: number) => M.top + ((H - M.top - M.bottom) * (hi - v)) / span;
  const alarmed = new Set(alarms.map((a) => a.orderId));

  const stepPath = (values: (number | null)[]): string => {
    const pts: string[] = [];
    values.forEach((v, i) => {
      if (v === null) return;
      const t = grid[i] ?? 0;
      pts.push(`${x(t).toFixed(1)},${y(v).toFixed(1)}`);
      const next = grid[i + 1];
      if (next !== undefined && values[i + 1] !== undefined && values[i + 1] !== null) {
        pts.push(`${x(next).toFixed(1)},${y(v).toFixed(1)}`);
      }
    });
    return pts.join(" ");
  };

  const parts: string[] = [];
  // Grid and axes.
  for (let v = lo; v <= hi; v++) {
    parts.push(`<line x1="${M.left}" x2="${W - M.right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="gridline"/>`);
    parts.push(`<text x="${M.left - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="tick">1e${v}</text>`);
  }
  const step = niceHourStep(tMax / HOUR_MS);
  for (let h = 0; h * HOUR_MS <= tMax; h += step) {
    parts.push(`<line x1="${x(h * HOUR_MS).toFixed(1)}" x2="${x(h * HOUR_MS).toFixed(1)}" y1="${M.top}" y2="${H - M.bottom}" class="gridline"/>`);
    parts.push(`<text x="${x(h * HOUR_MS).toFixed(1)}" y="${H - M.bottom + 16}" text-anchor="middle" class="tick">${h} h</text>`);
  }
  parts.push(`<text x="${(M.left + W - M.right) / 2}" y="${H - 6}" text-anchor="middle" class="axis">${openTime ? "ore di gioco attivo" : "ore di gioco simulato"}</text>`);
  parts.push(`<text transform="translate(14 ${(M.top + H - M.bottom) / 2}) rotate(-90)" text-anchor="middle" class="axis">prestigio all'ora (scala log)</text>`);

  // Thin orders first, then alarms, reference and median on top.
  const draw = (r: OrderResult, values: (number | null)[], color: string, width: number, opacity: number, dash = ""): void => {
    const points = stepPath(values);
    if (!points) return;
    parts.push(
      `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="${width}" stroke-opacity="${opacity}"${dash ? ` stroke-dasharray="${dash}"` : ""} stroke-linejoin="round"><title>${escapeHtml(r.id)} (${ORIGIN_LABEL[r.origin]})</title></polyline>`,
    );
  };
  for (const s of series) if (s.r.origin !== "reference" && !alarmed.has(s.r.id)) draw(s.r, s.values, ORIGIN_COLOR[s.r.origin], 1, 0.45);
  for (const s of series) if (s.r.origin !== "reference" && alarmed.has(s.r.id)) draw(s.r, s.values, ALARM_COLOR, 2.5, 0.95);
  const medianPoints = stepPath(median.map((v) => (finite(v) ? v : null)));
  if (medianPoints) {
    parts.push(
      `<polyline points="${medianPoints}" fill="none" stroke="${MEDIAN_COLOR}" stroke-width="3.5" stroke-dasharray="7 4" stroke-linejoin="round"><title>mediana</title></polyline>`,
    );
  }
  for (const s of series) if (s.r.origin === "reference") draw(s.r, s.values, ORIGIN_COLOR.reference, 3.5, 1);

  const used = new Set(results.map((r) => r.origin));
  const legend: string[] = [];
  for (const origin of Object.keys(ORIGIN_COLOR) as OrderOrigin[]) {
    if (!used.has(origin)) continue;
    legend.push(`<li><span class="sw" style="background:${ORIGIN_COLOR[origin]}"></span>${ORIGIN_LABEL[origin]}</li>`);
  }
  legend.push(`<li><span class="sw dashed"></span>mediana</li>`);
  if (alarmed.size > 0) legend.push(`<li><span class="sw" style="background:${ALARM_COLOR}"></span>ordine in allarme</li>`);

  return `<div class="scroll"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Tasso di prestigio all'ora nel tempo, un tracciato per ordine d'acquisto" style="min-width:560px">${parts.join("")}</svg></div>
<ul class="legend">${legend.join("")}</ul>`;
}

const table = (head: string[], rows: string[][]): string =>
  `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;

const code = (text: string): string => `<code>${escapeHtml(text)}</code>`;

const CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;padding:16px;background:#f8fafc;color:#111827;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto}
h1{font-size:1.5rem;margin:0 0 4px}
h2{font-size:1.15rem;margin:28px 0 8px}
section,header{background:#fff;border:1px solid #d1d5db;border-radius:8px;padding:12px 16px;margin:0 0 16px}
h2{margin-top:0}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 16px;margin:8px 0}
dt{color:#4b5563}dd{margin:0}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #e5e7eb;vertical-align:top}
th{background:#f1f5f9;white-space:nowrap}
td code,dd code{font:13px ui-monospace,Menlo,monospace;overflow-wrap:anywhere}
.tick{font-size:11px;fill:#374151}.axis{font-size:12px;fill:#374151}
.gridline{stroke:#e5e7eb;stroke-width:1}
.legend{list-style:none;display:flex;flex-wrap:wrap;gap:6px 16px;padding:0;margin:8px 0 0;font-size:13px}
.sw{display:inline-block;width:18px;height:4px;margin-right:6px;vertical-align:middle;border-radius:2px}
.sw.dashed{background:repeating-linear-gradient(90deg,#111827 0 6px,transparent 6px 10px);height:4px}
.ok{color:#047857;font-weight:600}.warn{color:#b91c1c;font-weight:600}
.note{color:#374151}
.empty{margin:8px 0}
`;

export function renderCalibrationHtml(analysis: CalibrationAnalysis, meta: CalibrationReportMeta): string {
  const { thresholds, results, alarms } = analysis;
  const anyRun = results.some((r) => r.runs.length > 0);

  const params: [string, string][] = [
    ["Passo della griglia", hours(thresholds.gridMs)],
    ["Passi per l'allarme di forma", String(thresholds.shapeSteps)],
    ["Crescita dello scarto (decadi)", String(thresholds.shapeGapGrowth)],
    ["Rapporto mediana/migliore (provvisorio)", String(thresholds.shiftRatio)],
    ["Peggioramento del ritmo", `${Math.round(thresholds.paceRegression * 100)}%`],
  ];
  if (finite(meta.maxJobs)) params.push(["Ordini simulati al massimo", String(meta.maxJobs)]);
  const provenance = Object.entries(meta.provenance ?? {});

  const head = `<header>
<h1>${escapeHtml(meta.title)}</h1>
<p class="note">Generato il ${escapeHtml(meta.generatedAt)}. Ordini simulati: ${results.length}.</p>
<dl>${params.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}${provenance
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${code(v)}</dd>`)
    .join("")}</dl>
<p class="note">La mediana conta come ordini distinti anche le copie del riferimento (gli ordini anticipato o ritardato uguali al riferimento).</p>
<p class="note">Limite noto: la regola rate decide sul guadagno continuo, la consegna è intera.</p>${
    meta.openTime ? `\n<p class="note">I tempi sono ore di gioco attivo: contano solo i momenti con la pagina aperta.</p>` : ""
  }
</header>`;

  const chart = `<section><h2>Tasso di prestigio nel tempo</h2>
<p class="note">Più le linee restano vicine alla mediana, più il negozio è equilibrato: un ordine che si stacca verso l'alto o il basso e continua ad allontanarsi segnala un acquisto troppo forte o troppo debole.</p>
${anyRun ? "" : `<p class="warn">Nessun ordine ha prestigiato entro l'orizzonte simulato.</p>`}
${renderChart(analysis, meta.openTime === true)}</section>`;

  const alarmRows = alarms.map((a) => [
    escapeHtml(KIND_LABEL[a.kind]),
    code(a.orderId),
    escapeHtml(a.detail),
    a.firstDivergence ? code(itemLabel(a.firstDivergence)) : a.milestone ? `traguardo ${escapeHtml(a.milestone)}` : "-",
  ]);
  const alarmSection = `<section><h2>Allarmi</h2>${
    alarms.length === 0 ? `<p class="ok">Nessun allarme.</p>` : table(["Tipo", "Ordine", "Dettaglio", "Prima divergenza"], alarmRows)
  }</section>`;

  const milestoneRows = Object.entries(analysis.milestoneSummary).map(([m, s]) => [
    escapeHtml(m),
    s.best === null ? "oltre l'orizzonte" : hours(s.best),
    s.median === null ? "oltre l'orizzonte" : hours(s.median),
    ratio(s.ratio),
  ]);
  const milestones = `<section><h2>Tempi ai traguardi</h2>${
    milestoneRows.length === 0 ? `<p class="empty">Nessun traguardo richiesto.</p>` : table(["Traguardo", "Migliore", "Mediana", "Rapporto"], milestoneRows)
  }</section>`;

  const firstRows = Object.entries(analysis.firstPurchase).map(([c, f]) => [code(c), f.best === null ? "mai" : hours(f.best), f.median === null ? "mai" : hours(f.median)]);
  const firstPurchase = `<section><h2>Primo acquisto</h2>
<p class="note">Quando viene comprato per la prima volta ogni upgrade: il tempo migliore tra gli ordini e la mediana.</p>${
    firstRows.length === 0 ? `<p class="empty">Nessun upgrade negli ordini.</p>` : table(["Upgrade", "Migliore", "Mediana"], firstRows)
  }</section>`;

  const delta = (v: number | null | undefined): string => (v === null || v === undefined ? "oltre l'orizzonte" : hours(v, true));
  const sensRows = analysis.sensitivity.flatMap((s) => Object.entries(s.milestoneDelta).map(([m, d]) => [code(s.code), escapeHtml(m), delta(d.anticipate), delta(d.delay)]));
  const sensitivity = `<section><h2>Sensibilità per upgrade</h2>
<p class="note">Differenza di tempo al traguardo rispetto al riferimento: negativa se l'acquisto anticipato fa arrivare prima.</p>${
    sensRows.length === 0 ? `<p class="empty">Nessun dato di sensibilità.</p>` : table(["Upgrade", "Traguardo", "Anticipato", "Ritardato"], sensRows)
  }</section>`;

  const phaseRows = analysis.phases.map((p) => [
    String(p.run),
    String(p.orders),
    hours(p.durationMs),
    ...analysis.phaseMarks.map((label) => (p.reached[label] ? `${hours(p.marks[label])}${p.reached[label]! < p.orders ? ` (${p.reached[label]}/${p.orders})` : ""}` : "-")),
  ]);
  const phases =
    analysis.phaseMarks.length === 0
      ? ""
      : `<section><h2>Fasi della run</h2>
<p class="note">Per ogni run, la mediana degli ordini: quanto dura e dopo quanto tempo dall'inizio della run arriva ogni fase. Tra parentesi, quante run ci sono arrivate quando non tutte.</p>${table(
          ["Run", "Ordini", "Durata", ...analysis.phaseMarks],
          phaseRows,
        )}</section>`;

  const orderRows = results.map((r) => [
    code(r.id),
    escapeHtml(ORIGIN_LABEL[r.origin]),
    code(compactOrder(r.order)),
    String(r.runs.length),
    r.blockedAt ? code(itemLabel(r.blockedAt)) : "-",
  ]);
  const orders = `<section><h2>Ordini</h2>${table(["Id", "Origine", "Voci dell'ordine", "Run", "Fermo su"], orderRows)}</section>`;

  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${head}
${chart}
${alarmSection}
${milestones}
${firstPurchase}
${sensitivity}
${phases}
${orders}
</main>
</body>
</html>
`;
}
