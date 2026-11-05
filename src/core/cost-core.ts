/**
 * 纯函数 · 成本合并
 *
 * 把治理侧按 session 查到的用量合并进 StepRecord。
 *
 * 口径（裁决 25）：
 * - 拿不到 → 标 `unavailable` 并写明原因，**不填 0**；
 * - 拿到了 → `tokens = promptTokens + completionTokens`，来源跟随 usage.source；
 * - 只有该步确实没有记录时才标 unavailable，不把整局的查询结果一概而论。
 */

import type { GovernanceUsage } from "../types/governance.js";
import type { StepRecord } from "../types/step.js";

export function mergeUsageIntoSteps(
  steps: readonly StepRecord[],
  usage: GovernanceUsage,
): StepRecord[] {
  if (usage.source === "unavailable") {
    const reason = usage.unavailableReason ?? "治理侧未提供用量数据";
    return steps.map((step) =>
      step.governance.tokens === undefined
        ? {
            ...step,
            governance: {
              ...step.governance,
              tokenSource: "unavailable",
              tokensUnavailableReason: reason,
            },
          }
        : step,
    );
  }

  const byStep = new Map(usage.byStep.map((entry) => [entry.stepNo, entry]));

  return steps.map((step) => {
    const entry = byStep.get(step.stepNo);
    if (!entry) {
      if (step.governance.tokens !== undefined) return step;
      return {
        ...step,
        governance: {
          ...step.governance,
          tokenSource: "unavailable",
          tokensUnavailableReason: "该步无治理侧用量记录",
        },
      };
    }

    return {
      ...step,
      governance: {
        ...step.governance,
        tokens: entry.promptTokens + entry.completionTokens,
        tokenSource: usage.source,
        tokensUnavailableReason: undefined,
      },
    };
  });
}
