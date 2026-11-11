/**
 * 证据原因码的中文标签与宽松解析。
 *
 * 报告里**只落原因码**（闭合枚举），不落原始错误文本或凭证；
 * 展示层通过这里的标签映射转成可读短句。
 *
 * `*CodeOf()` 用于解析不可信输入（历史报告 / 外部文件）：
 * 命中枚举就保留，其他任何字符串都收敛为 `unknown`，绝不回显原文。
 */

import type {
  DegradedReasonCode,
  StepErrorCode,
  TokenUnavailableReasonCode,
} from "../types/step.js";
import type { GovernanceDegradedReasonCode } from "../types/governance.js";

export const DEGRADED_REASON_LABELS: Record<DegradedReasonCode, string> = {
  "no-client": "未配置模型客户端（无密钥或模型端点不可用）",
  timeout: "模型调用超时",
  "invalid-action": "模型未返回合法动作",
  "http-error": "模型请求返回 HTTP 错误",
  "network-error": "模型连接失败",
  cancelled: "模型调用已取消",
  "invalid-response": "模型响应格式无效",
  unknown: "模型调用失败（未归类）",
};

export const STEP_ERROR_LABELS: Record<StepErrorCode, string> = {
  "governance-error": "治理调用失败，未执行游戏动作",
  "governance-denied": "治理拒绝执行（待审批或已驳回），未执行游戏动作",
  "game-request-failed": "游戏请求失败（网络或服务异常）",
  "game-action-unconfirmed": "动作未被确认成功，未取得后置状态",
  "replay-unobservable": "治理命中重放，但后置状态无法观察",
  "replay-diverged": "重放后游戏状态与预期不一致",
  "conditional-retry-unsupported": "需要条件重试，但适配器不支持该能力",
  "replay-compensation-failed": "重放补偿动作未被确认",
  "missing-post-state": "执行后未取得后置状态",
  unknown: "执行失败（未归类）",
};

export const TOKEN_UNAVAILABLE_REASON_LABELS: Record<TokenUnavailableReasonCode, string> = {
  "requires-session-query": "单次调用响应不含成本，需按 session 查询",
  "usage-query-failed": "治理用量查询失败",
  "usage-source-unavailable": "治理侧暂无该 session 的可归因用量",
  "no-step-record": "该步无治理侧用量记录",
  unknown: "未取得用量证据（未归类）",
};

export const GOVERNANCE_DEGRADED_REASON_LABELS: Record<GovernanceDegradedReasonCode, string> = {
  "forced-in-memory": "按要求强制使用内存治理替身（--governance=in-memory）",
  unreachable: "aiwarden 不可达（网络失败或超时），已降级到内存治理替身",
  "http-error": "aiwarden 探活返回 HTTP 错误，已降级到内存治理替身",
  "tool-not-registered": "aiwarden 可达但目标工具未注册，已降级到内存治理替身",
  unknown: "治理不可用或证据不完整，已显式降级",
};

export function degradedReasonCodeOf(value: unknown): DegradedReasonCode {
  return typeof value === "string" && Object.hasOwn(DEGRADED_REASON_LABELS, value)
    ? (value as DegradedReasonCode)
    : "unknown";
}

export function stepErrorCodeOf(value: unknown): StepErrorCode {
  return typeof value === "string" && Object.hasOwn(STEP_ERROR_LABELS, value)
    ? (value as StepErrorCode)
    : "unknown";
}

export function tokenUnavailableReasonCodeOf(value: unknown): TokenUnavailableReasonCode {
  return typeof value === "string" && Object.hasOwn(TOKEN_UNAVAILABLE_REASON_LABELS, value)
    ? (value as TokenUnavailableReasonCode)
    : "unknown";
}

export function governanceDegradedReasonCodeOf(value: unknown): GovernanceDegradedReasonCode {
  return typeof value === "string" && Object.hasOwn(GOVERNANCE_DEGRADED_REASON_LABELS, value)
    ? (value as GovernanceDegradedReasonCode)
    : "unknown";
}

export function degradedReasonLabel(code: DegradedReasonCode): string {
  return DEGRADED_REASON_LABELS[code];
}

export function stepErrorLabel(code: StepErrorCode): string {
  return STEP_ERROR_LABELS[code];
}

export function tokenUnavailableReasonLabel(code: TokenUnavailableReasonCode): string {
  return TOKEN_UNAVAILABLE_REASON_LABELS[code];
}

export function governanceDegradedReasonLabel(code: GovernanceDegradedReasonCode): string {
  return GOVERNANCE_DEGRADED_REASON_LABELS[code];
}
