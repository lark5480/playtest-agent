/**
 * 报告落盘薄壳
 *
 * 纯渲染在 `core/report-core.ts`；这里只负责目录与文件写入。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { parseReportJson } from "../core/recording.js";

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
  const safe = parseReportJson(report);
  const markdown = renderReportMarkdown(safe);
  const html = renderReportHtml(safe);
  const dir = resolve(options.dir ?? defaultReportsDir());
  const name = options.baseName ?? defaultBaseName(safe.scenario, safe.finishedAt);
  if (
    !name ||
    basename(name) !== name ||
    /[\\/:*?"<>|]/u.test(name) ||
    [...name].some((char) => char.charCodeAt(0) < 32) ||
    name === "." ||
    name === ".."
  ) {
    throw new Error("报告文件名必须是目录内的普通文件名");
  }
  const base = resolve(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${base}.md`, markdown, "utf8");
  writeFileSync(`${base}.json`, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  writeFileSync(`${base}.html`, html, "utf8");
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
  const safePrefix = prefix.replace(/[^\p{L}\p{N}_.-]/gu, "_").slice(0, 100) || "report";
  return `${safePrefix}-${stamp}`;
}
