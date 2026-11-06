import { snapshotHash } from "../core/recording.js";
import type { ReportJson, ReportStatus } from "../core/report-core.js";
import type { ExplorationMetrics } from "../types/game.js";

export interface ScanRun {
  readonly seed: number;
  readonly strategy: string;
  readonly status: ReportStatus | "not-run";
  readonly exitCode: number;
  readonly reason?: string;
  readonly report?: ReportJson;
  readonly reportFile?: string;
  readonly metrics?: ExplorationMetrics;
}

interface ScanOptions {
  readonly scenario: string;
  readonly game: string;
  readonly seedFrom: number;
  readonly seedTo: number;
  readonly maxSteps: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly runs: readonly ScanRun[];
  readonly comparing: boolean;
}

function pairOf(seed: number, runs: readonly ScanRun[]) {
  const baseline = runs.find((run) => run.seed === seed && run.strategy === "heuristic");
  const ai = runs.find((run) => run.seed === seed && run.strategy === "llm-explore");
  const left = baseline?.report;
  const right = ai?.report;
  const reasons: string[] = [];
  if (!left || !right) reasons.push("配对报告未到齐");
  if (left && right) {
    if (snapshotHash(left.initialState) !== snapshotHash(right.initialState))
      reasons.push("初始局面不同");
    if (
      left.metadata.target !== right.metadata.target ||
      left.metadata.maxSteps !== right.metadata.maxSteps
    )
      reasons.push("目标或步限不同");
    if (
      left.metadata.agentVersion !== right.metadata.agentVersion ||
      left.metadata.targetVersion !== right.metadata.targetVersion
    )
      reasons.push("运行版本不同");
    if (right.degradedSteps > 0) reasons.push("模型发生降级，不能当作完整AI样本");
    for (const report of [left, right]) {
      if (
        [
          "budget-limit",
          "execution-failed",
          "state-diverged",
          "stalled",
          "strategy-stopped",
        ].includes(report.stopReason)
      )
        reasons.push("运行提前中止");
    }
  }
  return {
    seed,
    comparable: reasons.length === 0,
    reasons: [...new Set(reasons)],
    ...(reasons.length === 0 && baseline?.metrics && ai?.metrics
      ? {
          uniqueStateDelta: ai.metrics.uniqueStates - baseline.metrics.uniqueStates,
          baselineEvents: baseline.metrics.events,
          aiEvents: ai.metrics.events,
          baselineReport: baseline.reportFile,
          aiReport: ai.reportFile,
        }
      : {}),
    note: "只比较指定窗口内的观测事实；未知服务版本与模型非确定性不支持因果或优胜结论",
  };
}

export function summarizeRuns(options: ScanOptions) {
  const exitCode =
    [6, 1, 5, 4].find((code) => options.runs.some((run) => run.exitCode === code)) ?? 0;
  const runs = options.runs.map((run) => ({
    seed: run.seed,
    strategy: run.strategy,
    status: run.status,
    exitCode: run.exitCode,
    ...(run.reason ? { reason: run.reason } : {}),
    ...(run.reportFile ? { reportFile: run.reportFile } : {}),
    ...(run.metrics ? { metrics: run.metrics } : {}),
    ...(run.report
      ? {
          stopReason: run.report.stopReason,
          steps: run.report.stepCount,
          degradedSteps: run.report.degradedSteps,
          elapsedMs: run.report.finishedAt - run.report.startedAt,
          findings: run.report.findings.map((finding) => ({
            code: finding.code,
            stepNo: finding.stepNo,
            severity: finding.severity,
          })),
          firstFindingStep:
            run.report.findings.find((finding) => finding.severity === "fatal")?.stepNo ?? null,
          modelCalls: run.report.budget?.attempts.length ?? 0,
          knownModelTokens: run.report.budget
            ? run.report.budget.attempts.reduce((sum, attempt) => sum + (attempt.tokens ?? 0), 0)
            : run.report.usage.llm,
          unknownModelCalls:
            run.report.budget?.attempts.filter((attempt) => attempt.state !== "settled").length ??
            0,
        }
      : {}),
  }));
  return {
    kind: "playtest-scan",
    schemaVersion: 2,
    scenario: options.scenario,
    game: options.game,
    seedFrom: options.seedFrom,
    seedTo: options.seedTo,
    maxSteps: options.maxSteps,
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    exitCode,
    runs,
    pairs: options.comparing
      ? [...new Set(options.runs.map((run) => run.seed))].map((seed) => pairOf(seed, options.runs))
      : [],
    totals: {
      runs: runs.length,
      passed: runs.filter((run) => run.status === "passed").length,
      failed: runs.filter((run) => run.status === "failed").length,
      incomplete: runs.filter((run) => run.status === "incomplete").length,
      notRun: runs.filter((run) => run.status === "not-run").length,
      steps: runs.reduce((sum, run) => sum + (run.steps ?? 0), 0),
    },
  };
}

export type ScanSummary = ReturnType<typeof summarizeRuns>;

function cell(value: unknown): string {
  return String(value ?? "不可用")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]/g, " ");
}

export function renderScanMarkdown(summary: ScanSummary): string {
  const lines = [
    `# Playtest 扫描 · ${summary.scenario}`,
    "",
    `seed ${summary.seedFrom}–${summary.seedTo}；每局上限 ${summary.maxSteps} 步。`,
    "",
    `完成 ${summary.totals.passed} / 断言失败 ${summary.totals.failed} / 未完整 ${summary.totals.incomplete} / 未运行 ${summary.totals.notRun}`,
    "",
    "| seed | 策略 | 结果/停止原因 | 唯一局面 | 首次违规 | 模型调用 | 已知 tokens | 未知调用 | 证据 |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const run of summary.runs) {
    lines.push(
      `| ${run.seed} | ${cell(run.strategy)} | ${cell(run.stopReason ?? run.reason ?? run.status)} | ${cell(run.metrics?.uniqueStates)} | ${cell(run.firstFindingStep)} | ${cell(run.modelCalls)} | ${cell(run.knownModelTokens)} | ${cell(run.unknownModelCalls)} | ${cell(run.reportFile)} |`,
    );
  }
  if (summary.pairs.length > 0) {
    lines.push("", "## 成对对照", "");
    for (const pair of summary.pairs) {
      lines.push(
        `- seed ${pair.seed}：${pair.comparable ? `同条件窗口，AI唯一局面数差 ${pair.uniqueStateDelta ?? "不可用"}` : `不可比：${pair.reasons.join("；")}`}。`,
      );
    }
  }
  lines.push(
    "",
    "断言清单不是实测覆盖率；未发现不等于无缺陷，发现仍需人工排除 Oracle 误报。",
    "未知用量不是零成本；此处不比较棋力，不预设 AI 胜出。",
    "",
  );
  return lines.join("\n");
}
