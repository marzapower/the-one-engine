import type { BalanceReport } from "./types";

const formatMs = (ms: number): string => {
  const sign = ms < 0 ? "-" : "";
  const totalSeconds = Math.round(Math.abs(ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${sign}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

/** Human-readable summary table of a `BalanceReport`, for console/CI output. */
export function formatReportSummary(report: BalanceReport): string {
  const lines: string[] = [];

  lines.push(`Balance report — bot=${report.meta.botId} generated=${report.meta.generatedAt}`);
  lines.push(`duration=${formatMs(report.meta.params.durationMs)} droppedIntents=${report.meta.droppedIntents} validationErrors=${report.meta.validationErrors.length}`);
  lines.push("");

  lines.push("Milestones:");
  if (report.milestones.length === 0) {
    lines.push("  (none)");
  } else {
    for (const m of report.milestones) {
      lines.push(`  ${formatMs(m.tSimMs)}  ${m.event}`);
    }
  }
  lines.push("");

  lines.push("Decade times (primary):");
  if (report.decadeTimes.length === 0) {
    lines.push("  (none)");
  } else {
    for (const d of report.decadeTimes) {
      lines.push(`  10^${d.decade}: at ${formatMs(d.tSimMs)} (+${formatMs(d.deltaMs)})`);
    }
  }
  lines.push("");

  lines.push(`Dead time: total=${formatMs(report.deadTime.totalMs)} windows=${report.deadTime.windows.length}`);
  const topWindows = [...report.deadTime.windows].sort((a, b) => b.toMs - b.fromMs - (a.toMs - a.fromMs)).slice(0, 5);
  for (const w of topWindows) {
    lines.push(`  ${formatMs(w.fromMs)} → ${formatMs(w.toMs)} (${formatMs(w.toMs - w.fromMs)})`);
  }
  lines.push("");

  lines.push("Decision density (actions/min per 5-min window):");
  if (report.decisionDensity.length === 0) {
    lines.push("  (none)");
  } else {
    for (const w of report.decisionDensity) {
      lines.push(`  ${formatMs(w.windowStartMs)}: ${w.actionsPerMin.toFixed(2)}/min`);
    }
  }
  lines.push("");

  lines.push(`Purchase rotation: switches=${report.purchaseRotation.switches} perHour=${report.purchaseRotation.perHour.toFixed(2)}`);
  lines.push("");

  lines.push("Prestige cycles:");
  if (report.prestigeCycles.length === 0) {
    lines.push("  (none)");
  } else {
    for (const c of report.prestigeCycles) {
      lines.push(`  #${c.index}: ${formatMs(c.startMs)} → ${formatMs(c.endMs)} (${formatMs(c.endMs - c.startMs)}) gain=${c.gain}`);
    }
  }

  return lines.join("\n");
}
