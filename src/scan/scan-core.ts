/**
 * 扫描汇总（纯函数）
 *
 * 只汇总**观测到的事实**：seed / 状态 / 步数 / finding code / 降级与重放计数。
 * 不在这里给"游戏有没有缺陷"下结论 —— 扫描发现需要人工复核 Oracle 误报。
 */

import { buildReportJson } from "../core/report-core.js";
import type { Finding, ReportStatus } from "../core/report-core.js";
import type { DriveResult } from "../driver/game-driver.js";

export interface ScanRun {
  readonly seed: number;
  readonly status: ReportStatus;
  readonly steps: number;
  readonly degradedSteps: number;
  readonly replayedSteps: number;
  readonly findings: readonly (Finding & { readonly seed: number })[];
  readonly error?: string;
}

export interface ScanSummary {
  readonly scenario: string;
  readonly game: string;
  readonly seedFrom: number;
  readonly seedTo: number;
  readonly maxSteps: number;
  readonly coverage: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly runs: readonly ScanRun[];
  readonly totals: {
    readonly runs: number;
    readonly passed: number;
    readonly failed: number;
    readonly incomplete: number;
    readonly steps: number;
    readonly findings: number;
  };
  readonly byCode: Readonly<Record<string, number>>;
}

export function summarizeResult(seed: number, result: DriveResult): ScanRun {
  const report = buildReportJson({
    scenario: result.scenario,
    session: result.session,
    businessKey: result.businessKey,
    seed: result.seed,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    steps: result.steps,
    findings: result.findings,
    governanceSource: "in-memory",
  });

  return {
    seed,
    status: report.status,
    steps: report.stepCount,
    degradedSteps: report.degradedSteps,
    replayedSteps: report.replayedSteps,
    findings: result.findings.map((finding) => ({ ...finding, seed })),
  };
}

export function summarizeError(seed: number, error: unknown): ScanRun {
  return {
    seed,
    status: "incomplete",
    steps: 0,
    degradedSteps: 0,
    replayedSteps: 0,
    findings: [],
    error: error instanceof Error ? error.message : String(error),
  };
}

export function summarizeRuns(params: {
  readonly scenario: string;
  readonly game: string;
  readonly seedFrom: number;
  readonly seedTo: number;
  readonly maxSteps: number;
  readonly coverage: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly runs: readonly ScanRun[];
}): ScanSummary {
  const byCode: Record<string, number> = {};
  let steps = 0;
  let findings = 0;
  let passed = 0;
  let failed = 0;
  let incomplete = 0;

  for (const run of params.runs) {
    steps += run.steps;
    findings += run.findings.length;
    if (run.status === "passed") passed += 1;
    else if (run.status === "failed") failed += 1;
    else incomplete += 1;
    for (const finding of run.findings) {
      byCode[finding.code] = (byCode[finding.code] ?? 0) + 1;
    }
  }

  return {
    scenario: params.scenario,
    game: params.game,
    seedFrom: params.seedFrom,
    seedTo: params.seedTo,
    maxSteps: params.maxSteps,
    coverage: params.coverage,
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    runs: params.runs,
    totals: {
      runs: params.runs.length,
      passed,
      failed,
      incomplete,
      steps,
      findings,
    },
    byCode,
  };
}

export function renderScanMarkdown(summary: ScanSummary): string {
  const lines: string[] = [];
  lines.push(`# Playtest 扫描 · ${summary.scenario}`);
  lines.push("");
  lines.push("| 项 | 值 |");
  lines.push("|---|---|");
  lines.push(`| 游戏 | ${summary.game} |`);
  lines.push(`| seed 区间 | ${summary.seedFrom}–${summary.seedTo} |`);
  lines.push(`| 每局步数上限 | ${summary.maxSteps} |`);
  lines.push(`| 断言覆盖 | ${summary.coverage} |`);
  lines.push(`| 运行数 | ${summary.totals.runs} |`);
  lines.push(
    `| passed / failed / incomplete | ${summary.totals.passed} / ${summary.totals.failed} / ${summary.totals.incomplete} |`,
  );
  lines.push(`| 总步数 | ${summary.totals.steps} |`);
  lines.push(`| 发现数 | ${summary.totals.findings} |`);
  lines.push("");

  lines.push("## 每局");
  lines.push("");
  lines.push("| seed | 状态 | 步数 | 发现 | 降级 | 重放 | 错误 |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const run of summary.runs) {
    lines.push(
      `| ${run.seed} | ${run.status} | ${run.steps} | ${run.findings.length} | ` +
        `${run.degradedSteps} | ${run.replayedSteps} | ${run.error ?? "-"} |`,
    );
  }
  lines.push("");

  lines.push("## 发现");
  lines.push("");
  if (summary.totals.findings === 0) {
    lines.push("无。");
  } else {
    lines.push("| seed | 编号 | 级别 | 步骤 | 描述 |");
    lines.push("|---|---|---|---|---|");
    for (const run of summary.runs) {
      for (const finding of run.findings) {
        lines.push(
          `| ${run.seed} | ${finding.code} | ${finding.severity} | ${finding.stepNo ?? "-"} | ${finding.message} |`,
        );
      }
    }
  }
  lines.push("");

  lines.push("## 说明");
  lines.push("");
  lines.push("- 扫描发现需要人工复核：先排除 Oracle 误报，再记为游戏缺陷。");
  lines.push("- 本报告只汇总观测事实；「未发现」不等于「游戏无缺陷」，需结合覆盖边界阅读。");
  lines.push("");

  return lines.join("\n");
}
