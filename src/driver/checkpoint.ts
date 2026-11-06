/**
 * 驱动层 · 检查点
 *
 * 检查点只落在 `reports/` 下（gitignore），因为里面含对局凭证 `token`。
 * 凭证纪律：**不打印、不写日志、不进报告**；错误信息只提字段名，不提值。
 *
 * 写盘采用「临时文件 + rename」的原子替换，避免崩在写一半留下半截 JSON。
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Finding } from "../core/report-core.js";
import type { Action, GameState, Observation } from "../types/game.js";
import type { ModelBudgetState } from "../types/budget.js";
import { validateModelBudgetState } from "../llm/budgeted-client.js";
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
  readonly schemaVersion: 2;
  readonly initialState: GameState;
  readonly budget?: ModelBudgetState;
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
  private lockIdentity: string | undefined;

  /** CLI 显式获取本地单写者锁；存活 PID 或无法确认的锁均拒绝。 */
  acquire(): void {
    if (this.lockIdentity) throw new Error("此检查点写者已持有锁");
    mkdirSync(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    const identity = JSON.stringify({ pid: process.pid, owner: randomUUID() });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        writeFileSync(lockPath, identity, { flag: "wx", mode: 0o600 });
        this.lockIdentity = identity;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST")
          throw new Error("无法建立检查点写者锁");
      }
      let raw: string;
      let pid: number;
      try {
        raw = readFileSync(lockPath, "utf8");
        const lock: unknown = JSON.parse(raw);
        if (!isRecord(lock) || !Number.isSafeInteger(lock["pid"]) || Number(lock["pid"]) <= 0)
          throw new Error();
        pid = Number(lock["pid"]);
      } catch {
        throw new Error("检查点锁无效，无法确认原写者退出；拒绝覆盖");
      }
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          throw new Error("无法确认检查点写者退出；拒绝覆盖");
        if (attempt === 0 && readFileSync(lockPath, "utf8") === raw) {
          rmSync(lockPath);
          continue;
        }
      }
      throw new Error("检查点已有活动写者；拒绝并行写入");
    }
    throw new Error("无法获取检查点写者锁");
  }

  release(): void {
    if (!this.lockIdentity) return;
    const lockPath = `${this.path}.lock`;
    if (readFileSync(lockPath, "utf8") !== this.lockIdentity)
      throw new Error("检查点锁所有者已改变，拒绝释放");
    rmSync(lockPath);
    this.lockIdentity = undefined;
  }

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
    const temp = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    // mode 0o600 在 Windows 上不生效，但在类 Unix 上限制为仅本人可读。
    writeFileSync(temp, JSON.stringify(checkpoint, null, 2), { encoding: "utf8", mode: 0o600 });
    try {
      renameSync(temp, this.path);
    } catch {
      // Windows 替换失败时绝不先删旧文件；旧的有效检查点必须保留。
      rmSync(temp, { force: true });
      throw new Error("检查点原子替换失败；上一有效文件已保留");
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

function assertState(value: unknown, field: string): void {
  if (!isRecord(value)) throw new Error(`检查点字段 ${field} 必须是状态对象`);
  requireString(value["id"], `${field}.id`);
  if (
    !["waiting", "playing", "finished"].includes(String(value["status"])) ||
    (value["turn"] !== null && typeof value["turn"] !== "string") ||
    !Array.isArray(value["legalActions"]) ||
    !isRecord(value["payload"])
  )
    throw new Error(`检查点字段 ${field} 状态无效`);
}

function assertCheckpoint(value: unknown): asserts value is Checkpoint {
  if (!isRecord(value)) throw new Error("检查点必须是对象");
  if (value["schemaVersion"] !== 2)
    throw new Error("检查点 schemaVersion 不兼容：必须是 2；旧文件已保留，请使用对应旧版本恢复");
  assertState(value["initialState"], "initialState");
  if (value["budget"] !== undefined) validateModelBudgetState(value["budget"]);

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
