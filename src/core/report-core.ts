/** 报告 v2：纯投影、统一结论与渲染；IO 留在 report/。 */
import type { ModelBudgetState } from "../types/budget.js";
import type { Action, GameState } from "../types/game.js";
import type { ErrorCategory, PublicSnapshot, RunMetadata, StopReason } from "../types/run.js";
import type {
  DegradedReasonCode,
  StepErrorCode,
  StepOutcome,
  StepRecord,
  TokenSource,
  TokenUnavailableReasonCode,
} from "../types/step.js";
import type { GovernanceDegradedReasonCode } from "../types/governance.js";
import { degradedReasonLabel, governanceDegradedReasonLabel } from "./evidence.js";
import { parseReportJson, publicAction, publicSnapshot, snapshotHash } from "./recording.js";

/** 三种不同单位绝不相加。null 表示没有完整可归因用量，而非零消耗。 */
export interface ReportUsage {
  readonly llm: number | null;
  readonly governance: number | null;
  readonly synthetic: number | null;
  readonly sources: readonly TokenSource[];
  readonly unavailableSteps: number;
}
export type ReportStatus = "passed" | "failed" | "incomplete";
export type AssertionStatus = "passed" | "failed" | "not-evaluated";
export interface Finding {
  readonly code: string;
  readonly severity: "fatal" | "warning";
  readonly message: string;
  readonly stepNo: number | null;
  readonly evidence?: readonly {
    readonly field: string;
    readonly expected: unknown;
    readonly actual: unknown;
  }[];
}
export interface StepJson {
  readonly stepNo: number;
  readonly actionId: string | null;
  readonly action: Action | null;
  readonly before: PublicSnapshot;
  readonly after: PublicSnapshot | null;
  readonly beforeHash: string;
  readonly afterHash: string | null;
  readonly outcome: StepOutcome;
  readonly degraded: boolean;
  readonly degradedReason?: DegradedReasonCode;
  readonly replayed: boolean;
  readonly digest: string;
  readonly elapsedMs: number;
  readonly error?: StepErrorCode;
  readonly traceId?: string;
  readonly llmTokens?: number;
  readonly governanceTokens?: number;
  readonly tokenSources?: readonly TokenSource[];
  readonly tokensUnavailableReason?: TokenUnavailableReasonCode;
}
export interface ReportJson {
  readonly schemaVersion: 2;
  readonly scenario: string;
  readonly session: string;
  readonly businessKey: string;
  readonly seed: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly metadata: RunMetadata;
  readonly initialState: PublicSnapshot;
  readonly finalState: PublicSnapshot;
  readonly stopReason: StopReason;
  readonly gameTerminal: boolean;
  readonly errorCategory?: ErrorCategory;
  readonly budget?: ModelBudgetState;
  readonly status: ReportStatus;
  readonly assertionStatus: AssertionStatus;
  readonly stepCount: number;
  readonly degradedSteps: number;
  readonly replayedSteps: number;
  readonly failedSteps: number;
  readonly governanceSource: string;
  readonly governanceDegradedReason?: GovernanceDegradedReasonCode;
  readonly usage: ReportUsage;
  readonly findings: readonly Finding[];
  readonly steps: readonly StepJson[];
}

/** 构建与严格读取共用，避免 CLI / 渲染器各自猜测结论。 */
export function deriveReportResult(
  report: Pick<
    ReportJson,
    | "steps"
    | "findings"
    | "stopReason"
    | "gameTerminal"
    | "finalState"
    | "metadata"
    | "errorCategory"
  >,
): { status: ReportStatus; assertionStatus: AssertionStatus } {
  if (report.findings.some((finding) => finding.severity === "fatal")) {
    return { status: "failed", assertionStatus: "failed" };
  }
  const terminal =
    report.gameTerminal &&
    report.finalState.status === "finished" &&
    report.finalState.turn === null &&
    report.finalState.legalActions.length === 0 &&
    (report.metadata.game === "othello"
      ? report.finalState.payload["winner"] !== null
      : report.finalState.payload["result"] !== null);
  const checkedStep = report.steps.some(
    (step) =>
      step.action !== null &&
      step.after !== null &&
      (step.outcome === "applied" || step.outcome === "replayed"),
  );
  const checked = report.metadata.oracle !== "unknown" && (checkedStep || terminal);
  const completeSteps = report.steps.every(
    (step) =>
      step.action !== null &&
      step.after !== null &&
      (step.outcome === "applied" || step.outcome === "replayed"),
  );
  return {
    status:
      terminal &&
      checked &&
      completeSteps &&
      !report.errorCategory &&
      report.stopReason === "game-finished"
        ? "passed"
        : "incomplete",
    assertionStatus: checked ? "passed" : "not-evaluated",
  };
}

/** 模型账目优先于动作账目，包含未形成动作的尝试且不双计。 */
export function summarizeUsage(steps: readonly StepJson[], budget?: ModelBudgetState): ReportUsage {
  const sources = new Set<TokenSource>();
  for (const step of steps) for (const source of step.tokenSources ?? []) sources.add(source);
  const sumComplete = (values: readonly (number | undefined)[]): number | null =>
    values.length > 0 && values.every((value) => value !== undefined)
      ? values.reduce<number>((sum, value) => sum + value!, 0)
      : null;
  const llm = budget
    ? sumComplete(
        budget.attempts.map((attempt) =>
          attempt.state === "settled" ? attempt.tokens : undefined,
        ),
      )
    : sumComplete(steps.map((step) => step.llmTokens));
  if (budget?.attempts.some((attempt) => attempt.tokens !== undefined)) sources.add("model-usage");
  if (
    budget?.attempts.some((attempt) => attempt.state !== "settled" || attempt.tokens === undefined)
  )
    sources.add("unavailable");
  const unattributed = steps.some(
    (step) =>
      step.governanceTokens === undefined &&
      !(step.tokenSources ?? []).some(
        (source) => source === "synthetic" || source === "governance-usage",
      ),
  );
  const ofSource = (source: TokenSource): number | null =>
    unattributed
      ? null
      : sumComplete(
          steps
            .filter((step) => step.tokenSources?.includes(source))
            .map((step) => step.governanceTokens),
        );
  return {
    llm,
    governance: ofSource("governance-usage"),
    synthetic: ofSource("synthetic"),
    sources: [...sources].sort(),
    unavailableSteps: steps.filter(
      (step) => step.llmTokens === undefined && step.governanceTokens === undefined,
    ).length,
  };
}

export function reportExitCode(report: ReportJson): number {
  if (report.findings.some((finding) => finding.severity === "fatal")) return 1;
  if (report.stopReason === "state-diverged" || report.errorCategory === "state") return 4;
  if (
    report.stopReason === "execution-failed" ||
    report.errorCategory === "governance" ||
    report.errorCategory === "game" ||
    report.errorCategory === "strategy"
  )
    return 6;
  return deriveReportResult(report).status === "passed" ? 0 : 5;
}

export function buildReportJson(params: {
  readonly scenario: string;
  readonly session: string;
  readonly businessKey: string;
  readonly seed: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly metadata: RunMetadata;
  readonly initialState: GameState;
  readonly finalState: GameState;
  readonly stopReason: StopReason;
  readonly gameTerminal: boolean;
  readonly errorCategory?: ErrorCategory;
  readonly budget?: ModelBudgetState;
  readonly steps: readonly StepRecord[];
  readonly findings: readonly Finding[];
  readonly governanceSource?: string;
  readonly governanceDegradedReason?: GovernanceDegradedReasonCode;
}): ReportJson {
  const game = params.metadata.game;
  const governanceSource = params.governanceSource ?? "unknown";
  const steps: StepJson[] = params.steps.map((step) => {
    const before = publicSnapshot(game, step.observation.state);
    const after = step.observationAfter ? publicSnapshot(game, step.observationAfter.state) : null;
    const action = step.action === null ? null : publicAction(game, step.action);
    const tokenSources: TokenSource[] = [];
    if (step.llmTokens !== undefined) tokenSources.push("model-usage");
    if (step.governance.tokenSource) tokenSources.push(step.governance.tokenSource);
    else if (step.governance.tokens !== undefined)
      tokenSources.push(governanceSource === "in-memory" ? "synthetic" : "governance-usage");
    return {
      stepNo: step.stepNo,
      actionId: action?.id ?? null,
      action,
      before,
      after,
      beforeHash: snapshotHash(before),
      afterHash: after ? snapshotHash(after) : null,
      outcome: step.outcome,
      degraded: step.degraded,
      ...(step.degraded ? { degradedReason: step.degradedReason ?? "unknown" } : {}),
      replayed: step.governance.replayed,
      digest: step.fingerprint.digest,
      elapsedMs: step.elapsedMs,
      ...(step.error ? { error: step.error } : {}),
      ...(step.governance.traceId ? { traceId: step.governance.traceId } : {}),
      ...(step.llmTokens !== undefined ? { llmTokens: step.llmTokens } : {}),
      ...(step.governance.tokens !== undefined ? { governanceTokens: step.governance.tokens } : {}),
      ...(tokenSources.length ? { tokenSources: [...new Set(tokenSources)].sort() } : {}),
      ...(step.governance.tokensUnavailableReason
        ? { tokensUnavailableReason: step.governance.tokensUnavailableReason }
        : {}),
    };
  });
  const projected = {
    metadata: params.metadata,
    initialState: publicSnapshot(game, params.initialState),
    finalState: publicSnapshot(game, params.finalState),
    stopReason: params.stopReason,
    gameTerminal: params.gameTerminal,
    errorCategory: params.errorCategory,
    steps,
    findings: params.findings,
  };
  return parseReportJson({
    schemaVersion: 2,
    scenario: params.scenario,
    session: params.session,
    businessKey: params.businessKey,
    seed: params.seed,
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    ...projected,
    ...deriveReportResult(projected),
    ...(params.budget ? { budget: params.budget } : {}),
    stepCount: steps.length,
    degradedSteps: steps.filter((step) => step.degraded).length,
    replayedSteps: steps.filter((step) => step.replayed).length,
    failedSteps: steps.filter((step) => step.outcome === "failed" || step.outcome === "rejected")
      .length,
    governanceSource,
    ...(params.governanceDegradedReason
      ? { governanceDegradedReason: params.governanceDegradedReason }
      : {}),
    usage: summarizeUsage(steps, params.budget),
  });
}

export function escapeMarkdown(value: unknown): string {
  return String(value ?? "-")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "&#124;")
    .replace(/`/g, "&#96;")
    .replace(/[\r\n]/g, " ")
    .replace(/([\\*_[\]])/g, "\\$1");
}

export function renderReportMarkdown(input: ReportJson): string {
  const report = parseReportJson(input);
  const e = escapeMarkdown;
  const lines = [
    `# Playtest 报告 · ${e(report.scenario)}`,
    "",
    "| 项 | 值 |",
    "|---|---|",
    `| 状态 | **${report.status}** |`,
    `| 断言 | ${report.assertionStatus} |`,
    `| 停止原因 | ${report.stopReason} |`,
    `| 游戏终局 | ${report.gameTerminal ? "是" : "否"} |`,
    `| 错误类别 | ${report.errorCategory ?? "无"} |`,
    `| 证据来源 | ${report.metadata.source} |`,
    `| 游戏 / 目标版本 | ${report.metadata.game} / ${e(report.metadata.targetVersion)} |`,
    `| Agent / Oracle / 策略 | ${e(report.metadata.agentVersion)} / ${e(report.metadata.oracle)} / ${e(report.metadata.strategy)} |`,
    `| 会话 / 对局 | ${e(report.session)} / ${e(report.businessKey)} |`,
    `| 随机种子 | ${report.seed} |`,
    `| 步数 / 上限 | ${report.stepCount} / ${report.metadata.maxSteps} |`,
    `| 降级 / 重放 / 失败步数 | ${report.degradedSteps} / ${report.replayedSteps} / ${report.failedSteps} |`,
    `| 治理来源 | ${e(report.governanceSource)} |`,
    "",
  ];
  if (report.governanceDegradedReason)
    lines.push(
      `> 治理降级：${e(governanceDegradedReasonLabel(report.governanceDegradedReason))}`,
      "",
    );
  lines.push(
    "## 治理证据",
    "",
    "| 项 | 值 |",
    "|---|---|",
    `| LLM tokens | ${report.usage.llm ?? "unknown"} |`,
    `| 治理配额当量 | ${report.usage.governance ?? "unknown"} |`,
    `| 替身合成值 | ${report.usage.synthetic ?? "unknown"} |`,
    `| 来源 | ${report.usage.sources.join(", ") || "无"} |`,
    `| 无成本数据步数 | ${report.usage.unavailableSteps} |`,
    "",
    "> 三种单位分列；合成值不代表真实成本。unknown 不是 0；已知部分不能冒充完整总用量。",
    "",
  );
  if (report.budget)
    lines.push(
      `> 模型尝试 ${report.budget.attempts.length}/${report.budget.maxCalls}；token 软停止线 ${report.budget.tokenLimit ?? "未设置"}。`,
      "",
    );
  lines.push("## 发现", "");
  if (!report.findings.length) lines.push("无。未发现违规不等于整局已完成。");
  else {
    lines.push("| 编号 | 级别 | 步骤 | 描述 |", "|---|---|---|---|");
    for (const finding of report.findings) {
      lines.push(
        `| ${e(finding.code)} | ${finding.severity} | ${finding.stepNo ?? "-"} | ${e(finding.message)} |`,
      );
      for (const evidence of finding.evidence ?? [])
        lines.push(
          `| ${e(evidence.field)} | Oracle 预期 / 实际 | ${finding.stepNo ?? "-"} | ${e(JSON.stringify(evidence.expected))} / ${e(JSON.stringify(evidence.actual))} |`,
        );
    }
  }
  lines.push(
    "",
    "## 步骤",
    "",
    "| # | 动作 | 结果 | 幂等 | 降级 | 分源用量 | trace | 摘要 | 耗时(ms) |",
    "|---|---|---|---|---|---|---|---|---|",
  );
  for (const step of report.steps) {
    const gov =
      step.governanceTokens === undefined
        ? `gov:unknown${step.tokensUnavailableReason ? `（${step.tokensUnavailableReason}）` : ""}`
        : `${step.tokenSources?.includes("synthetic") ? "synthetic" : "gov"}:${step.governanceTokens}`;
    const tokens = `${step.llmTokens === undefined ? "llm:unknown" : `llm:${step.llmTokens}`} / ${gov}`;
    lines.push(
      `| ${step.stepNo} | ${e(step.actionId)} | ${step.outcome}${step.error ? `（${step.error}）` : ""} | ${step.replayed ? "是" : "否"} | ${step.degraded ? `是（${step.degradedReason}）` : "否"} | ${tokens} | ${e(step.traceId)} | ${step.beforeHash.slice(0, 12)} → ${step.afterHash?.slice(0, 12) ?? "unknown"} | ${step.elapsedMs} |`,
    );
  }
  const reasons = [
    ...new Set(
      report.steps
        .map((step) => step.degradedReason)
        .filter((reason): reason is DegradedReasonCode => reason !== undefined),
    ),
  ];
  if (reasons.length)
    lines.push(
      "",
      "## 降级说明",
      "",
      ...reasons.map((reason) => `- \`${reason}\`：${e(degradedReasonLabel(reason))}`),
    );
  return `${lines.join("\n")}\n`;
}
