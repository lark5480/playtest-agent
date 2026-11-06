/** 有条件的证据对比；不以 finding 数量或短前缀替代修复证明。 */
import { canonicalize } from "./fingerprint.js";
import { parseReportJson, snapshotHash } from "./recording.js";
import { escapeMarkdown } from "./report-core.js";
import type { ReportJson } from "./report-core.js";
import type { PublicSnapshot } from "../types/run.js";

export interface ReportDiff {
  readonly comparable: boolean;
  readonly reasons: string[];
  readonly addedFindings: string[];
  readonly removedFindings: string[];
  readonly firstDivergence: number | null;
  readonly conclusion: string;
}
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}
function fieldValue(snapshot: PublicSnapshot, field: string): unknown {
  const key = field.replace(/^payload\./, "");
  if (key === "status") return snapshot.status;
  if (key === "turn") return snapshot.turn;
  if (key === "legalActions") return snapshot.legalActions;
  if (key === "legalActions.length") return snapshot.legalActions.length;
  const parts = key.replace(/\[(\d+)\]/g, ".$1").split(".");
  let value: unknown = snapshot.payload;
  for (const part of parts) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part))
      return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function diffReports(beforeInput: ReportJson, afterInput: ReportJson): ReportDiff {
  const before = parseReportJson(beforeInput);
  const after = parseReportJson(afterInput);
  const reasons: string[] = [];
  const condition = (label: string, left: unknown, right: unknown) => {
    if (!same(left, right)) reasons.push(`${label} 不同`);
  };
  condition("游戏", before.metadata.game, after.metadata.game);
  condition("初始局面", snapshotHash(before.initialState), snapshotHash(after.initialState));
  condition("seed", before.seed, after.seed);
  for (const key of [
    "adapter",
    "oracle",
    "strategy",
    "agentVersion",
    "target",
    "promptVersion",
    "maxSteps",
  ] as const) {
    condition(key, before.metadata[key], after.metadata[key]);
  }
  condition(
    "模型预算",
    before.budget
      ? { maxCalls: before.budget.maxCalls, tokenLimit: before.budget.tokenLimit }
      : null,
    after.budget ? { maxCalls: after.budget.maxCalls, tokenLimit: after.budget.tokenLimit } : null,
  );
  condition("治理来源", before.governanceSource, after.governanceSource);
  for (const key of ["agentVersion", "targetVersion", "adapter", "oracle", "strategy"] as const) {
    if (
      [before.metadata[key], after.metadata[key]].some((value) => value.toLowerCase() === "unknown")
    )
      reasons.push(`${key} 为 unknown，版本或执行身份不足以作修复证据`);
  }
  if (
    [before, after].some(
      (report) =>
        /llm/i.test(report.metadata.strategy) &&
        (!report.metadata.promptVersion ||
          report.metadata.promptVersion.toLowerCase() === "unknown"),
    )
  )
    reasons.push("LLM prompt 版本缺失或 unknown");
  if (before.degradedSteps || after.degradedSteps) reasons.push("存在策略降级，不能作为同策略对照");

  let firstDivergence: number | null =
    snapshotHash(before.initialState) === snapshotHash(after.initialState) ? null : 0;
  let changedAction = false;
  const common = Math.min(before.steps.length, after.steps.length);
  for (let index = 0; index < common; index++) {
    const left = before.steps[index]!;
    const right = after.steps[index]!;
    const actionDiffers = !same(left.action, right.action);
    changedAction ||= actionDiffers;
    if (
      firstDivergence === null &&
      (actionDiffers ||
        left.beforeHash !== right.beforeHash ||
        left.afterHash !== right.afterHash ||
        left.outcome !== right.outcome)
    )
      firstDivergence = index;
  }
  if (firstDivergence === null && before.steps.length !== after.steps.length)
    firstDivergence = common;
  if (changedAction) reasons.push("记录动作路径不同；不同 LLM 采样或策略路径不能冒充同序列回归");
  const codesBefore = new Set(before.findings.map((finding) => finding.code));
  const codesAfter = new Set(after.findings.map((finding) => finding.code));
  const addedFindings = [...codesAfter].filter((code) => !codesBefore.has(code)).sort();
  const removedFindings = [...codesBefore].filter((code) => !codesAfter.has(code)).sort();
  const comparable = reasons.length === 0;
  let conclusion: string;
  if (!comparable) {
    conclusion = "不可作为同条件修复对照；发现增减与首处分歧仅为记录差异，不代表已修复。";
  } else {
    const variable =
      before.metadata.targetVersion === after.metadata.targetVersion
        ? "目标版本相同。"
        : `目标版本 ${before.metadata.targetVersion} → ${after.metadata.targetVersion} 是明确对照变量。`;
    const target = before.findings
      .filter((finding) => finding.severity === "fatal")
      .sort((left, right) => (left.stepNo ?? -1) - (right.stepNo ?? -1))[0];
    if (target) {
      const step = target.stepNo === null ? undefined : after.steps[target.stepNo];
      const reached =
        step?.after !== null &&
        step?.after !== undefined &&
        (step.outcome === "applied" || step.outcome === "replayed") &&
        (firstDivergence === null || firstDivergence >= target.stepNo!);
      const targetAbsent = !codesAfter.has(target.code);
      const otherFatal = after.findings.some(
        (finding) =>
          finding.severity === "fatal" &&
          (finding.stepNo === null || target.stepNo === null || finding.stepNo <= target.stepNo),
      );
      const expectedVerified =
        reached &&
        !!target.evidence?.length &&
        target.evidence.every((entry) =>
          same(fieldValue(step!.after!, entry.field), entry.expected),
        );
      if (targetAbsent && expectedVerified && !otherFatal)
        conclusion = `${variable}同动作前缀到达原首错步骤 ${target.stepNo}，目标违规 ${target.code} 未出现，且观察值满足已记录 Oracle 预期；仅验证该前缀，不代表整局或全面修复。`;
      else if (!targetAbsent)
        conclusion = `${variable}目标违规 ${target.code} 仍有记录；首错步变化本身不是修复证据。`;
      else
        conclusion = `${variable}目标违规未出现在后报告，但未到目标步、提前分歧或缺少一致的 Oracle 预期证据；结论不足，不能声称修复。`;
    } else if (
      firstDivergence === null &&
      before.steps.length > 0 &&
      after.steps.every((step) => step.after !== null)
    ) {
      conclusion = `${variable}已记录动作与公开状态序列一致；只验证记录范围，不推断未执行部分。`;
    } else
      conclusion = `${variable}仅能确认记录范围内的差异；无可验证的原首错目标，不给出修复结论。`;
  }
  return { comparable, reasons, addedFindings, removedFindings, firstDivergence, conclusion };
}

export function renderDiffMarkdown(diff: ReportDiff): string {
  const e = escapeMarkdown;
  return [
    "# Playtest 报告对比",
    "",
    `- 可比：${diff.comparable ? "是" : "否"}`,
    `- 首处分歧步骤（0 起）：${diff.firstDivergence ?? "无"}`,
    `- 新增发现：${diff.addedFindings.map(e).join(", ") || "无"}`,
    `- 移除发现：${diff.removedFindings.map(e).join(", ") || "无"}`,
    "",
    ...diff.reasons.map((reason) => `- 限制：${e(reason)}`),
    "",
    e(diff.conclusion),
    "",
  ].join("\n");
}
