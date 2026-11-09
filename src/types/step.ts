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
 * 成本/token 的来源口径。
 *
 * - `model-usage`：模型响应里的 usage（真实 token）
 * - `governance-usage`：治理侧用量明细（aiwarden 工具调用配额当量）
 * - `synthetic`：内存替身的固定模拟值，**不是**真实成本
 * - `unavailable`：本应可归因但未拿到，报告必须显式说明
 */
export type TokenSource = "model-usage" | "governance-usage" | "synthetic" | "unavailable";

/**
 * 降级原因码（闭合枚举）。
 *
 * 报告只允许以下值：**原始错误文本与凭证一律不入报告**，
 * 但原因必须可归因（超时 ≠ 无密钥 ≠ 模型给了非法动作）。
 */
export type DegradedReasonCode =
  /** 未配置模型客户端（无密钥或端点不可用）。 */
  | "no-client"
  /** 模型调用超时。 */
  | "timeout"
  /** 模型未返回合法动作。 */
  | "invalid-action"
  /** 模型请求返回 HTTP 错误。 */
  | "http-error"
  /** 模型连接失败。 */
  | "network-error"
  /** 模型调用已取消。 */
  | "cancelled"
  /** 模型响应格式无效。 */
  | "invalid-response"
  /** 未归类的调用失败。 */
  | "unknown";

/**
 * 执行失败原因码（闭合枚举）。
 *
 * 与 `ErrorCategory`（粗分类）互补：一类说明"哪一层出错"，这里说明"错在哪一步"。
 */
export type StepErrorCode =
  /** 治理调用失败，未执行游戏动作。 */
  | "governance-error"
  /** 适配器动作请求失败（网络 / 服务异常）。 */
  | "game-request-failed"
  /** 动作未被确认成功，未取得后置状态。 */
  | "game-action-unconfirmed"
  /** 治理命中重放，但后置状态无法观察。 */
  | "replay-unobservable"
  /** 重放后游戏状态与预期不一致。 */
  | "replay-diverged"
  /** 需要条件重试，但适配器不支持该能力。 */
  | "conditional-retry-unsupported"
  /** 重放补偿动作未被确认。 */
  | "replay-compensation-failed"
  /** 执行后未取得后置状态。 */
  | "missing-post-state"
  /** 未归类的失败（仅用于解析不可信 / 历史报告）。 */
  | "unknown";

/**
 * 未取得治理用量的原因码（闭合枚举）。
 */
export type TokenUnavailableReasonCode =
  /** 单次治理调用响应不含成本，需按 session 查询。 */
  | "requires-session-query"
  /** 治理用量查询失败（网络或响应无效）。 */
  | "usage-query-failed"
  /** 治理侧暂无可归因用量。 */
  | "usage-source-unavailable"
  /** 该步无治理侧用量记录。 */
  | "no-step-record"
  /** 未归类的缺失原因。 */
  | "unknown";

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
  /** 本步治理侧消耗的 token 数（无治理调用/未取得时不填）。 */
  readonly tokens?: number;
  /** 治理侧 token 数的来源口径。 */
  readonly tokenSource?: TokenSource;
  /** 未取得治理侧成本时的显式原因码。 */
  readonly tokensUnavailableReason?: TokenUnavailableReasonCode;
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
  /** 降级原因码（降级时为必填码，原始错误文本不入报告）。 */
  readonly degradedReason?: DegradedReasonCode;
  /** 模型调用消耗的 token 数（确定性基线 / 未取得时为不填）。 */
  readonly llmTokens?: number;
  /** 实际参与决策的模型标识（未使用模型时不填）。 */
  readonly model?: string;
  /** 执行结果。 */
  readonly outcome: StepOutcome;
  /** 执行后观察；执行失败时为 null。 */
  readonly observationAfter: Observation | null;
  /** 失败原因码（outcome 为 rejected / failed 时）。 */
  readonly error?: StepErrorCode;
  /** 治理证据。 */
  readonly governance: GovernanceEvidence;
  /** 步骤耗时（毫秒）。 */
  readonly elapsedMs: number;
}
