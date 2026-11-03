/**
 * 纯函数内核 · 幂等指纹（地基冻结契约 ③）
 *
 * 指纹 = businessKey + session + 步骤指纹（步骤序号 + 动作规范化内容）。
 *
 * **冻结契约**：算法与规范化规则一旦发布不得更改——
 * 改了会让历史 session 的续跑认不出重放，产生第二次副作用。
 *
 * 规范化规则（必须与此处一致）：
 * 1. 键按字典序递归排序（同名键只可能有一个，不做数组去重）；
 * 2. 数组保持原顺序（顺序有语义：动作序列不可打乱）；
 * 3. `undefined` 的键直接丢弃（与 JSON 序列化行为一致）；
 * 4. 摘要取 SHA-256 的前 16 字节十六进制（32 字符）。
 */

import { createHash } from "node:crypto";

import type { Action } from "../types/game.js";
import type { IdempotencyFingerprint } from "../types/step.js";

/**
 * 规范化任意 JSON 值：递归排序对象键，丢弃 undefined。
 *
 * 数组保持原顺序 —— 动作的顺序有语义，不能打乱。
 */
export function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const canonical = canonicalize(source[key]);
      if (canonical !== undefined) out[key] = canonical;
    }
    return out;
  }
  if (typeof value === "number") {
    // NaN / Infinity 不是合法 JSON，转成 null 以保证摘要可复现
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "undefined" || typeof value === "function") return undefined;
  return value;
}

/**
 * 计算动作内容的摘要。
 *
 * 只吃**规范化后的内容**，不吃 Action.id —— id 是展示用的稳定标识，
 * 参与指纹会让"同一语义动作、不同 id"被误判为两个动作。
 *
 * @param stepNo 步骤序号。**参与摘要** —— 同一动作出现在不同步号属于
 *   不同步骤；若步号不入摘要，"第 3 步与第 7 步做了同一个动作"会撞键，
 *   续跑时会误判为重放而跳过真实动作。
 */
export function digestOf(action: Action | null, stepNo: number): string {
  const canonical = canonicalize({ stepNo, payload: action?.payload ?? null });
  const json = JSON.stringify(canonical);
  return createHash("sha256").update(json, "utf8").digest("hex").slice(0, 32);
}

/**
 * 组装幂等指纹。
 *
 * @param businessKey 对局标识（房间码 / session id）
 * @param session 运行标识（一次 playtest 执行的 session key）
 * @param stepNo 步骤序号（从 0 起）
 * @param action 本步动作（null 表示终止步）
 */
export function computeFingerprint(params: {
  readonly businessKey: string;
  readonly session: string;
  readonly stepNo: number;
  readonly action: Action | null;
}): IdempotencyFingerprint {
  return {
    businessKey: params.businessKey,
    session: params.session,
    stepNo: params.stepNo,
    digest: digestOf(params.action, params.stepNo),
  };
}

/**
 * 指纹的稳定字符串形式（用于日志、报告与幂等键拼接）。
 */
export function fingerprintKey(fingerprint: IdempotencyFingerprint): string {
  return [
    fingerprint.businessKey,
    fingerprint.session,
    String(fingerprint.stepNo),
    fingerprint.digest,
  ].join(":");
}
