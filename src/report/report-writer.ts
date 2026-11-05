/**
 * 报告落盘薄壳
 *
 * 纯渲染在 `core/report-core.ts`；这里只负责目录与文件写入。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderReportMarkdown } from "../core/report-core.js";
import type { ReportJson } from "../core/report-core.js";
import { renderReportHtml } from "./report-html.js";

export interface PairPaths {
  readonly md: string;
  readonly json: string;
}

export interface ReportPaths extends PairPaths {
  readonly html: string;
}

export function defaultReportsDir(): string {
  return resolve(process.cwd(), "reports");
}

export function writeReport(
  report: ReportJson,
  options: { readonly dir?: string; readonly baseName?: string } = {},
): ReportPaths {
  const dir = resolve(options.dir ?? defaultReportsDir());
  mkdirSync(dir, { recursive: true });
  const base = resolve(
    dir,
    options.baseName ?? defaultBaseName(report.scenario, report.finishedAt),
  );
  writeFileSync(`${base}.md`, renderReportMarkdown(report), "utf8");
  writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(`${base}.html`, renderReportHtml(report), "utf8");
  return { md: `${base}.md`, json: `${base}.json`, html: `${base}.html` };
}

export function writeTextPair(params: {
  readonly dir?: string;
  readonly baseName: string;
  readonly markdown: string;
  readonly json: unknown;
}): PairPaths {
  const dir = resolve(params.dir ?? defaultReportsDir());
  mkdirSync(dir, { recursive: true });
  const base = resolve(dir, params.baseName);
  writeFileSync(`${base}.md`, params.markdown, "utf8");
  writeFileSync(`${base}.json`, `${JSON.stringify(params.json, null, 2)}\n`, "utf8");
  return { md: `${base}.md`, json: `${base}.json` };
}

export function defaultBaseName(prefix: string, at: number): string {
  const stamp = new Date(at).toISOString().replace(/[:.]/g, "-");
  return `${prefix}-${stamp}`;
}
