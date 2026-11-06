import type { GameAdapter } from "../adapter/game-adapter.js";
import { hashOf } from "../core/state-hash.js";
import { snapshotHash } from "../core/recording.js";
import { buildReportJson, type ReportJson } from "../core/report-core.js";
import { drive } from "../driver/game-driver.js";
import { InMemoryGovernanceClient } from "../governance/client.js";
import type { Oracle } from "../oracle/oracle.js";
import { RecordedStrategy } from "../strategy/recorded.js";
import type { RunMetadata } from "../types/run.js";

export type ReplayOutcome =
  "reproduced" | "verified" | "not-reproduced" | "diverged" | "inconclusive";

export interface ReplayResult {
  readonly outcome: ReplayOutcome;
  readonly firstDivergence: number | null;
  readonly verifiedSteps: number;
  readonly message: string;
  readonly report: ReportJson;
}

export function compareReplay(
  recording: ReportJson,
  actual: ReportJson,
): Omit<ReplayResult, "report"> {
  if (snapshotHash(recording.initialState) !== snapshotHash(actual.initialState)) {
    return { outcome: "diverged", firstDivergence: 0, verifiedSteps: 0, message: "初始局面不一致" };
  }
  let firstDivergence: number | null = null;
  let verifiedSteps = 0;
  for (let i = 0; i < actual.steps.length; i += 1) {
    const expected = recording.steps[i];
    const observed = actual.steps[i]!;
    if (
      !expected ||
      expected.beforeHash !== observed.beforeHash ||
      expected.afterHash !== observed.afterHash ||
      hashOf(expected.action) !== hashOf(observed.action)
    ) {
      firstDivergence = i;
      break;
    }
    verifiedSteps += 1;
  }
  const target = recording.findings.find((finding) => finding.severity === "fatal");
  const targetStep = target?.stepNo ?? null;
  if (target && targetStep !== null) {
    if (firstDivergence !== null && firstDivergence < targetStep) {
      return {
        outcome: "diverged",
        firstDivergence,
        verifiedSteps,
        message: "到达原首错步骤前轨迹已经分歧",
      };
    }
    if (actual.steps.length <= targetStep || !actual.steps[targetStep]?.after) {
      return {
        outcome: "inconclusive",
        firstDivergence,
        verifiedSteps,
        message: "没有取得原首错步骤的完整执行证据",
      };
    }
    const reproduced = actual.findings.some(
      (finding) =>
        finding.code === target.code &&
        finding.stepNo === targetStep &&
        finding.severity === target.severity &&
        hashOf(finding.evidence ?? []) === hashOf(target.evidence ?? []),
    );
    if (firstDivergence === null && reproduced) {
      return {
        outcome: "reproduced",
        firstDivergence,
        verifiedSteps,
        message: "同一动作前缀复现同一违规及证据",
      };
    }
    if (
      firstDivergence === targetStep &&
      !actual.findings.some((finding) => finding.severity === "fatal") &&
      actual.steps[targetStep]?.outcome === "applied"
    ) {
      return {
        outcome: "not-reproduced",
        firstDivergence,
        verifiedSteps,
        message: "已到达原首错步骤且当前 Oracle 通过；目标违规在该前缀消失，不代表整局无缺陷",
      };
    }
    return {
      outcome: "inconclusive",
      firstDivergence,
      verifiedSteps,
      message: "已执行目标前缀，但没有取得一致的复现证据",
    };
  }
  if (firstDivergence !== null) {
    return {
      outcome: "diverged",
      firstDivergence,
      verifiedSteps,
      message: "录制轨迹与实际状态分歧",
    };
  }
  if (
    actual.steps.length !== recording.steps.length ||
    actual.findings.some((f) => f.severity === "fatal")
  ) {
    return {
      outcome: "inconclusive",
      firstDivergence,
      verifiedSteps,
      message: "未验证完整录制序列",
    };
  }
  return {
    outcome: "verified",
    firstDivergence,
    verifiedSteps,
    message: "完整录制序列已验证，不重新询问模型",
  };
}

export async function replayRecording(
  recording: ReportJson,
  options: { adapter: GameAdapter; oracle: Oracle; metadata: RunMetadata },
): Promise<ReplayResult> {
  const governance = new InMemoryGovernanceClient();
  const result = await drive({
    adapter: options.adapter,
    oracle: options.oracle,
    strategy: new RecordedStrategy(recording),
    governance,
    scenario: recording.scenario,
    seed: recording.seed,
    maxSteps: recording.steps.length + 1,
  });
  const report = buildReportJson({
    ...result,
    metadata: { ...options.metadata, strategy: "recorded", maxSteps: recording.steps.length },
    governanceSource: governance.name,
  });
  return { ...compareReplay(recording, report), report };
}
