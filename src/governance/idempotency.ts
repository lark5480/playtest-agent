/**
 * 治理层 · 幂等键装配（地基冻结契约 ⑦）
 *
 * 幂等键的构成与 aiwarden 的口径对齐（ADR-013 决策 6）：
 *   **businessKey + session + 步骤指纹**
 *
 * aiwarden 侧的 businessKey 就是"对局标识"，session 是"运行标识"。
 * 本模块只负责把三段拼成一个**稳定字符串**并做基本校验 ——
 * 不做哈希（aiwarden 侧会再算一次指纹），保持两侧可对照。
 */

import type { IdempotencyFingerprint } from "../types/step.js";

/**
 * 幂等键的字符串形式。
 *
 * 格式：`{businessKey}::{session}::{stepNo}::{digest}`
 *
 * 用 `::` 分隔而非 `:` —— 业务键本身可能含冒号（房间码虽不含，但业务键是开放的），
 * 双冒号降低歧义。
 */
export function buildIdempotencyKey(fingerprint: IdempotencyFingerprint): string {
  return [
    fingerprint.businessKey,
    fingerprint.session,
    String(fingerprint.stepNo),
    fingerprint.digest,
  ].join("::");
}

/**
 * 校验幂等键各段非空。
 *
 * 空的 businessKey / session 会让 aiwarden 侧的键退化成"按消息指纹"，
 * 续跑时匹配不上 —— 宁可在这里失败，也不要在续跑时才发现。
 */
export function assertIdempotencyKey(fingerprint: IdempotencyFingerprint): void {
  if (!fingerprint.businessKey || fingerprint.businessKey.trim() === "") {
    throw new Error("幂等键缺 businessKey（对局标识）");
  }
  if (!fingerprint.session || fingerprint.session.trim() === "") {
    throw new Error("幂等键缺 session（运行标识）");
  }
  if (!Number.isInteger(fingerprint.stepNo) || fingerprint.stepNo < 0) {
    throw new Error(`幂等键的 stepNo 非法：${fingerprint.stepNo}`);
  }
  if (!fingerprint.digest || fingerprint.digest.length !== 32) {
    throw new Error(`幂等键的 digest 非法：${fingerprint.digest}`);
  }
}
