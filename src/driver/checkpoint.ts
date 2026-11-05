/**
 * 驱动层 · 检查点
 *
 * 检查点只落在 `reports/` 下（gitignore），因为里面含对局凭证 `token`。
 * 凭证纪律：**不打印、不写日志、不进报告**；错误信息只提字段名，不提值。
 *
 * 写盘采用「临时文件 + rename」的原子替换，避免崩在写一半留下半截 JSON。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Finding } from "../core/report-core.js";
import type { Action, Observation } from "../types/game.js";
import type { IdempotencyFingerprint, StepRecord } from "../types/step.js";

/**
 * 已决策但尚未确认提交的一步。
 *
 * `expectedAfterHash` 由适配器的本地投影算出；没有投影能力时为 undefined，
 * 恢复时无法判定「动作是否已生效」→ 显式失败，不允许猜。
 */
export interface PendingStep {
  readonly stepNo: number;
  readonly action: Action;
  readonly reason: string;
  readonly degraded: boolean;
  readonly degradedReason?: string;
  readonly llmTokens?: number;
  readonly model?: string;
  readonly fingerprint: IdempotencyFingerprint;
  readonly beforeObservation: Observation;
  readonly beforeStateHash: string;
  readonly expectedAfterHash?: string;
}

/** 一份完整检查点。 */
export interface Checkpoint {
  readonly schemaVersion: 1;
  readonly scenario: string;
  readonly seed: number;
  readonly adapter: string;
  readonly governanceSource: string;
  readonly session: string;
  readonly businessKey: string;
  readonly token: string;
  readonly startedAt: number;
  readonly nextStepNo: number;
  readonly lastObservationSeq: number;
  readonly steps: readonly StepRecord[];
  readonly findings: readonly Finding[];
  readonly pending?: PendingStep;
}

/** 驱动只依赖这个最小写盘接口，测试可注入内存实现。 */
export interface CheckpointStore {
  readonly path: string;
  save(checkpoint: Checkpoint): void;
  remove(): void;
}

export class FileCheckpointStore implements CheckpointStore {
  public readonly path: string;

  public constructor(filePath: string) {
    this.path = resolve(filePath);
  }

  read(): Checkpoint {
    if (!existsSync(this.path)) {
      throw new Error(`检查点不存在：${this.path}`);
    }
    const raw = readFileSync(this.path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`检查点不是合法 JSON：${this.path}`);
    }
    assertCheckpoint(parsed);
    return parsed;
  }

  save(checkpoint: Checkpoint): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp-${process.pid}`;
    // mode 0o600 在 Windows 上不生效，但在类 Unix 上限制为仅本人可读。
    writeFileSync(temp, JSON.stringify(checkpoint, null, 2), { encoding: "utf8", mode: 0o600 });
    try {
      renameSync(temp, this.path);
    } catch (error) {
      // Windows 上 rename 覆盖已存在文件可能返回 EPERM/EACCES。
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
        rmSync(this.path, { force: true });
        renameSync(temp, this.path);
      } else {
        rmSync(temp, { force: true });
        throw error;
      }
    }
  }

  remove(): void {
    rmSync(this.path, { force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`检查点字段 ${field} 缺失或类型错误`);
  }
}

function requireNumber(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`检查点字段 ${field} 缺失或类型错误`);
  }
}

function assertCheckpoint(value: unknown): asserts value is Checkpoint {
  if (!isRecord(value)) throw new Error("检查点必须是对象");
  if (value["schemaVersion"] !== 1) throw new Error("检查点 schemaVersion 必须是 1");

  for (const field of [
    "scenario",
    "adapter",
    "governanceSource",
    "session",
    "businessKey",
    "token",
  ]) {
    requireString(value[field], field);
  }
  for (const field of ["seed", "startedAt", "nextStepNo", "lastObservationSeq"]) {
    requireNumber(value[field], field);
  }
  if (!Array.isArray(value["steps"])) throw new Error("检查点字段 steps 必须是数组");
  if (!Array.isArray(value["findings"])) throw new Error("检查点字段 findings 必须是数组");

  const pending = value["pending"];
  if (pending !== undefined) {
    if (!isRecord(pending)) throw new Error("检查点字段 pending 必须是对象");
    requireNumber(pending["stepNo"], "pending.stepNo");
    requireString(pending["reason"], "pending.reason");
    requireString(pending["beforeStateHash"], "pending.beforeStateHash");
    if (!isRecord(pending["action"])) throw new Error("检查点字段 pending.action 必须是对象");
    if (!isRecord(pending["fingerprint"])) {
      throw new Error("检查点字段 pending.fingerprint 必须是对象");
    }
    if (!isRecord(pending["beforeObservation"])) {
      throw new Error("检查点字段 pending.beforeObservation 必须是对象");
    }
  }
}
