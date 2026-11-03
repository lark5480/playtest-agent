/**
 * 共享类型 · 步骤记录（地基冻结契约 ②）
 *
 * 一条 StepRecord = Agent 在一局里的一次完整动作及其全部证据。
 * 它是报告的原子单位，也是治理层的记账单位。
 */

import type { Action, Observation } from "./game.js";

/**
 * 单步执行结果。
 */
export type StepOutcome =
  /** 动作已生效（首次执行）。 */
  | "applied"
  /** 动作命中幂等终态，**未重复生效**（续跑重放）。 */
  | "replayed"
  /** 动作被拒绝（非法动作 / 治理拒绝）。 */
  | "rejected"
  /** 执行出错（网络失败 / 被测游戏不可用）。 */
  | "failed";

/**
 * 幂等指纹：动作的唯一身份。
 *
 * 由 businessKey（对局）+ session（运行）+ 步骤指纹（动作序号 + 规范化内容）三段构成。
 * **指纹算法一旦冻结不可更改**——改了会让历史 session 的续跑认不出重放。
 */
export interface IdempotencyFingerprint {
  /** 业务键：对局标识（房间码 / session id）。 */
  readonly businessKey: string;
  /** 运行标识：一次 playtest 执行的 session key。 */
  readonly session: string;
  /** 步骤序号：从 0 起单调递增。 */
  readonly stepNo: number;
  /** 步骤指纹：动作规范化内容的摘要。 */
  readonly digest: string;
}

/**
 * 治理证据：这一步在治理侧的凭据。
 *
 * 成本归因四维（租户 / 会话 / 步骤 / 工具）在 aiwarden 侧落库；
 * 这里只保留本项目需要的归集信息，**不落库**（见 PRD §10）。
 */
export interface GovernanceEvidence {
  /** 幂等调用是否命中已有终态（true = 未重复产生副作用）。 */
  readonly replayed: boolean;
  /** 调用耗时（毫秒）。 */
  readonly elapsedMs: number;
  /** 治理侧 traceId（可与 aiwarden 的 trace 串联）。 */
  readonly traceId?: string;
  /** 本步消耗的 token 数（无模型调用时为 0）。 */
  readonly tokens?: number;
}

/**
 * 一条步骤记录。
 *
 * 字段刻意分成三组：
 * - **输入**：`stepNo` / `observation` / `action` —— 复现所需；
 * - **结果**：`outcome` / `observationAfter` —— 判定所需；
 * - **证据**：`fingerprint` / `governance` —— 治理与审计所需。
 */
export interface StepRecord {
  /** 步骤序号，从 0 起单调递增。 */
  readonly stepNo: number;
  /** 幂等指纹。 */
  readonly fingerprint: IdempotencyFingerprint;
  /** 决策前观察。 */
  readonly observation: Observation;
  /** 选中的动作（无动作时为 null）。 */
  readonly action: Action | null;
  /** 决策理由。 */
  readonly reason: string;
  /** 本步是否走降级路径。 */
  readonly degraded: boolean;
  /** 降级原因。 */
  readonly degradedReason?: string;
  /** 执行结果。 */
  readonly outcome: StepOutcome;
  /** 执行后观察；执行失败时为 null。 */
  readonly observationAfter: Observation | null;
  /** 失败原因（outcome 为 rejected / failed 时）。 */
  readonly error?: string;
  /** 治理证据。 */
  readonly governance: GovernanceEvidence;
  /** 步骤耗时（毫秒）。 */
  readonly elapsedMs: number;
}
