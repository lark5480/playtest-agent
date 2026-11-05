/**
 * 纯函数内核 · 报告渲染（地基冻结契约 ⑧）
 *
 * 报告的**纯渲染**在此，薄壳（写文件）在 `src/report/`。
 * 渲染必须是纯函数：同样的步骤序列必得同样的报告字节，
 * 这样报告才能进版本控制、能被 diff、能作为验收证据。
 *
 * JSON 结构冻结：报告要被机器再解析（跨场景对比、基线 diff）。
 */

import type { StepOutcome, StepRecord, TokenSource } from "../types/step.js";

/**
 * 报告的成本汇总（只汇总**真实取得**的数值，缺失步单独计数）。
 */
export interface ReportUsage {
  readonly llm: number;
  readonly governance: number;
  readonly total: number;
  readonly sources: readonly TokenSource[];
  /** 既没有 llmTokens 也没有 governance tokens 的步数。 */
  readonly unavailableSteps: number;
}

/**
 * 报告的机器可读结构（冻结契约 ⑧）。
 */
export interface ReportJson {
  readonly schemaVersion: 1;
  readonly scenario: string;
  readonly session: string;
  readonly businessKey: string;
  readonly seed: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly status: ReportStatus;
  readonly stepCount: number;
  readonly degradedSteps: number;
  readonly replayedSteps: number;
  readonly failedSteps: number;
  /** 治理来源（"aiwarden-http" = 真实治理面；"in-memory" = 降级替身）。 */
  readonly governanceSource: string;
  /** 治理降级说明（降级时非空）。 */
  readonly governanceDegradedReason?: string;
  /** 成本汇总（无可归因数据时 total=0 且 unavailableSteps>0）。 */
  readonly usage: ReportUsage;
  readonly findings: readonly Finding[];
  readonly steps: readonly StepJson[];
}

export type ReportStatus = "passed" | "failed" | "incomplete";

/**
 * 一条发现（缺陷或告警）。
 */
export interface Finding {
  /** 缺陷编号（稳定标识，便于跨次运行对照）。 */
  readonly code: string;
  /** 严重级别。 */
  readonly severity: "fatal" | "warning";
  /** 描述。 */
  readonly message: string;
  /** 关联的步骤序号；无关联时为 null。 */
  readonly stepNo: number | null;
}

/**
 * 单步的机器可读结构。
 */
export interface StepJson {
  readonly stepNo: number;
  readonly actionId: string | null;
  readonly outcome: StepOutcome;
  readonly degraded: boolean;
  readonly degradedReason?: string;
  readonly replayed: boolean;
  readonly digest: string;
  readonly elapsedMs: number;
  readonly error?: string;
  /** 治理侧 traceId（真实实现不提供时不填）。 */
  readonly traceId?: string;
  /** 本步模型调用消耗的 token 数。 */
  readonly llmTokens?: number;
  /** 本步治理侧消耗的 token 数。 */
  readonly governanceTokens?: number;
  /** 本步 token 数据来源（可能同时有模型与治理两个来源）。 */
  readonly tokenSources?: readonly TokenSource[];
  /** 未取得成本数据的显式原因。 */
  readonly tokensUnavailableReason?: string;
}

/** 终态对应的报告状态。 */
function statusOf(steps: readonly StepRecord[], findings: readonly Finding[]): ReportStatus {
  if (findings.some((f) => f.severity === "fatal")) return "failed";
  if (findings.length > 0) return "passed";
  const last = steps[steps.length - 1];
  if (!last) return "incomplete";
  if (last.outcome === "failed" || last.outcome === "rejected") return "incomplete";
  return "passed";
}

/**
 * 按治理来源推断缺省口径：
 * 内存替身的固定 token 是合成值，不能冒充真实成本。
 */
function fallbackTokenSource(governanceSource: string): TokenSource {
  return governanceSource === "in-memory" ? "synthetic" : "governance-usage";
}

function tokenSourcesOf(step: StepRecord, fallback: TokenSource): TokenSource[] {
  const sources = new Set<TokenSource>();
  if (step.llmTokens !== undefined) sources.add("model-usage");
  if (step.governance.tokens !== undefined) {
    sources.add(step.governance.tokenSource ?? fallback);
  } else if (step.governance.tokenSource) {
    sources.add(step.governance.tokenSource);
  }
  return [...sources];
}

function usageOf(steps: readonly StepRecord[], fallback: TokenSource): ReportUsage {
  let llm = 0;
  let governance = 0;
  let unavailableSteps = 0;
  const sources = new Set<TokenSource>();

  for (const step of steps) {
    if (step.llmTokens !== undefined) {
      llm += step.llmTokens;
      sources.add("model-usage");
    }
    if (step.governance.tokens !== undefined) {
      governance += step.governance.tokens;
      sources.add(step.governance.tokenSource ?? fallback);
    } else if (step.governance.tokenSource) {
      sources.add(step.governance.tokenSource);
    }
    if (step.llmTokens === undefined && step.governance.tokens === undefined) {
      unavailableSteps += 1;
    }
  }

  return { llm, governance, total: llm + governance, sources: [...sources], unavailableSteps };
}

/**
 * 把步骤序列转成机器可读报告（纯函数）。
 */
export function buildReportJson(params: {
  readonly scenario: string;
  readonly session: string;
  readonly businessKey: string;
  readonly seed: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly steps: readonly StepRecord[];
  readonly findings: readonly Finding[];
  readonly governanceSource?: string;
  readonly governanceDegradedReason?: string;
}): ReportJson {
  const { steps, findings } = params;
  const governanceSource = params.governanceSource ?? "unknown";
  const fallback = fallbackTokenSource(governanceSource);

  return {
    schemaVersion: 1,
    scenario: params.scenario,
    session: params.session,
    businessKey: params.businessKey,
    seed: params.seed,
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    status: statusOf(steps, findings),
    stepCount: steps.length,
    degradedSteps: steps.filter((s) => s.degraded).length,
    replayedSteps: steps.filter((s) => s.governance.replayed).length,
    failedSteps: steps.filter((s) => s.outcome === "failed" || s.outcome === "rejected").length,
    governanceSource,
    ...(params.governanceDegradedReason
      ? { governanceDegradedReason: params.governanceDegradedReason }
      : {}),
    usage: usageOf(steps, fallback),
    findings,
    steps: steps.map((s) => ({
      stepNo: s.stepNo,
      actionId: s.action?.id ?? null,
      outcome: s.outcome,
      degraded: s.degraded,
      ...(s.degradedReason ? { degradedReason: s.degradedReason } : {}),
      replayed: s.governance.replayed,
      digest: s.fingerprint.digest,
      elapsedMs: s.elapsedMs,
      ...(s.error ? { error: s.error } : {}),
      ...(s.governance.traceId ? { traceId: s.governance.traceId } : {}),
      ...(s.llmTokens !== undefined ? { llmTokens: s.llmTokens } : {}),
      ...(s.governance.tokens !== undefined ? { governanceTokens: s.governance.tokens } : {}),
      ...(tokenSourcesOf(s, fallback).length > 0
        ? { tokenSources: tokenSourcesOf(s, fallback) }
        : {}),
      ...(s.governance.tokensUnavailableReason
        ? { tokensUnavailableReason: s.governance.tokensUnavailableReason }
        : {}),
    })),
  };
}

/**
 * 把报告渲染成 Markdown（纯函数）。
 *
 * 报告结构对齐 `othello-online/tests/playtest/bug-report-template.md`，
 * 编号体系与 `smoke-checklist.md` 对齐 —— 机器结果能直接接人工观察表。
 */
export function renderReportMarkdown(report: ReportJson): string {
  const lines: string[] = [];
  lines.push(`# Playtest 报告 · ${report.scenario}`);
  lines.push("");
  lines.push("| 项 | 值 |");
  lines.push("|---|---|");
  lines.push(`| 状态 | **${report.status}** |`);
  lines.push(`| 场景 | ${report.scenario} |`);
  lines.push(`| 会话 | \`${report.session}\` |`);
  lines.push(`| 对局 | \`${report.businessKey}\` |`);
  lines.push(`| 随机种子 | \`${report.seed}\` |`);
  lines.push(`| 步数 | ${report.stepCount} |`);
  lines.push(`| 降级步数 | ${report.degradedSteps} |`);
  lines.push(`| 重放步数（幂等命中） | ${report.replayedSteps} |`);
  lines.push(`| 失败步数 | ${report.failedSteps} |`);
  lines.push(`| 治理来源 | \`${report.governanceSource}\` |`);
  lines.push("");
  if (report.governanceDegradedReason) {
    lines.push(`> ⚠️ **治理降级**：${report.governanceDegradedReason}`);
    lines.push("");
  }

  lines.push("## 治理证据");
  lines.push("");
  lines.push("| 项 | 值 |");
  lines.push("|---|---|");
  lines.push(`| LLM tokens | ${report.usage.llm} |`);
  lines.push(`| 治理 tokens | ${report.usage.governance} |`);
  lines.push(`| tokens 合计 | ${report.usage.total} |`);
  lines.push(
    `| token 来源 | ${report.usage.sources.length > 0 ? report.usage.sources.join(", ") : "无"} |`,
  );
  lines.push(`| 无成本数据步数 | ${report.usage.unavailableSteps} |`);
  lines.push(
    `| traceId 覆盖步数 | ${report.steps.filter((s) => s.traceId).length}/${report.stepCount} |`,
  );
  lines.push("");
  if (report.usage.sources.includes("synthetic")) {
    lines.push("> 内存替身的 token 数是固定合成值，不代表真实成本。");
    lines.push("");
  }
  if (report.usage.sources.includes("governance-usage")) {
    lines.push("> 治理 tokens 为 aiwarden 工具调用的配额当量，不是模型 token。");
    lines.push("");
  }
  if (report.usage.unavailableSteps > 0) {
    lines.push(`> 有 ${report.usage.unavailableSteps} 步未取得成本数据；报告中未填 0。`);
    lines.push("");
  }

  lines.push("## 发现");
  lines.push("");
  if (report.findings.length === 0) {
    lines.push("无。");
  } else {
    lines.push("| 编号 | 级别 | 步骤 | 描述 |");
    lines.push("|---|---|---|---|");
    for (const f of report.findings) {
      lines.push(`| ${f.code} | ${f.severity} | ${f.stepNo ?? "-"} | ${f.message} |`);
    }
  }
  lines.push("");

  lines.push("## 步骤");
  lines.push("");
  lines.push("| # | 动作 | 结果 | 幂等 | 降级 | tokens | trace | 摘要 | 耗时(ms) |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const s of report.steps) {
    const tokens = [
      s.llmTokens !== undefined ? `llm:${s.llmTokens}` : "",
      s.governanceTokens !== undefined ? `gov:${s.governanceTokens}` : "",
    ]
      .filter(Boolean)
      .join(" / ");
    const trace = s.traceId ?? "-";
    lines.push(
      `| ${s.stepNo} | ${s.actionId ?? "-"} | ${s.outcome} | ${s.replayed ? "是" : "否"} | ` +
        `${s.degraded ? "是" : "否"} | ${tokens || "-"} | ${trace} | ` +
        `\`${s.digest.slice(0, 8)}\` | ${s.elapsedMs} |`,
    );
  }
  lines.push("");

  // 降级原因单列一节 —— 承诺 C4 的证据："模型不可用时游戏仍可玩，且**如实标注**"。
  const degradedReasons = [
    ...new Set(
      report.steps.filter((s) => s.degraded && s.degradedReason).map((s) => s.degradedReason!),
    ),
  ];
  if (degradedReasons.length > 0) {
    lines.push("## 降级说明");
    lines.push("");
    for (const reason of degradedReasons) {
      lines.push(`- ${reason}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
