import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { BalanceReport } from "./balance/types";

/** Writes a `BalanceReport` as readable JSON, creating the target directories as needed. */
export function writeReport(report: BalanceReport, filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(report, null, 2), "utf-8");
}
