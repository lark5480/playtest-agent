/**
 * 驱动层 · GameDriver
 *
 * 把地基组装起来：观察 → 决策 → 执行 → 断言 → 记录 → 下一轮。
 *
 * 这一层**做 IO**（调适配器、策略、治理、检查点），但**不含业务规则**——
 * 规则全在 `core/` 的纯函数里。这样驱动层很薄，业务逻辑可单测。
 */

import { driveMeta, isTerminal, planNextStep } from "../core/driver-core.js";
import type { DriveContext } from "../core/driver-core.js";
import type { Finding } from "../core/report-core.js";
import { decideResumeAction } from "../core/resume.js";
import { stateHashOf } from "../core/state-hash.js";
import { assertIdempotencyKey } from "../governance/idempotency.js";
import type { GameAdapter } from "../adapter/game-adapter.js";
import type { GovernanceClient } from "../types/governance.js";
import type { Action, GameState, Observation } from "../types/game.js";
import type { Oracle, OracleViolation } from "../oracle/oracle.js";
import type { Strategy } from "../strategy/strategy.js";
import type { StepOutcome, StepRecord, TokenSource } from "../types/step.js";
import type { Checkpoint, CheckpointStore, PendingStep } from "./checkpoint.js";

/**
 * 驱动配置。
 */
export interface DriveOptions {
  readonly adapter: GameAdapter;
  readonly strategy: Strategy;
  readonly oracle: Oracle;
  readonly governance: GovernanceClient;
  /** 场景标识（写进报告）。 */
  readonly scenario: string;
  /** 随机种子。 */
  readonly seed: number;
  /** 最大步数（防止失控长跑）。 */
  readonly maxSteps?: number;
  /** 在第 N 步执行完之后注入崩溃（用于验证续跑语义）。 */
  readonly injectCrashAfterStep?: number;
  /** 检查点写盘（可选；含凭证，必须落在 gitignore 目录）。 */
  readonly checkpoint?: CheckpointStore;
  /** 从检查点续跑（可选）。 */
  readonly resume?: Checkpoint;
}

export interface DriveResult {
  readonly scenario: string;
  readonly session: string;
  readonly businessKey: string;
  readonly seed: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly steps: readonly StepRecord[];
  readonly findings: readonly Finding[];
  readonly terminal: boolean;
}

/**
 * 崩溃注入点：模拟"动作已生效、检查点未落"的窗口。
 */
export class InjectedCrash extends Error {
  public constructor(public readonly afterStepNo: number) {
    super(`注入崩溃：第 ${afterStepNo} 步执行完成后`);
    this.name = "InjectedCrash";
  }
}

/**
 * 对局无法恢复（房间丢失 / 适配器不支持 resume）。
 *
 * **不自动新开一局**——那会让报告看起来跑完了，实际换了一局。
 */
export class ResumeUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ResumeUnavailableError";
  }
}

/**
 * 续跑时真实状态与检查点对不上（状态发散）。
 */
export class ResumeDivergedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ResumeDivergedError";
  }
}

interface ExecutionResult {
  readonly outcome: StepOutcome;
  readonly observationAfter: Observation | null;
  readonly error?: string;
  readonly replayed: boolean;
  readonly traceId?: string;
  readonly tokens?: number;
  readonly tokenSource?: TokenSource;
  readonly tokensUnavailableReason?: string;
  readonly elapsedMs: number;
  readonly findings: readonly Finding[];
}

/**
 * 驱动执行一次场景。
 *
 * @throws InjectedCrash 当命中注入点（用于验证续跑 —— 崩溃后应能接着跑）。
 * @throws ResumeUnavailableError 续跑时对局不可恢复。
 * @throws ResumeDivergedError 续跑时状态与检查点不一致。
 */
export async function drive(options: DriveOptions): Promise<DriveResult> {
  const maxSteps = options.maxSteps ?? 200;
  const checkpoint = options.resume;
  if (checkpoint) validateResume(options, checkpoint);

  const session = checkpoint?.session ?? `pt-${options.scenario}-${options.seed}`;
  const startedAt = checkpoint?.startedAt ?? Date.now();
  const steps: StepRecord[] = checkpoint ? [...checkpoint.steps] : [];
  const findings: Finding[] = checkpoint ? [...checkpoint.findings] : [];

  let businessKey: string;
  let token: string;
  let observation: Observation;
  let stepNo: number;
  let terminal: boolean;

  if (checkpoint) {
    businessKey = checkpoint.businessKey;
    token = checkpoint.token;
    const restored = options.adapter.resume ? await options.adapter.resume({ token }) : null;
    if (!restored) {
      throw new ResumeUnavailableError(
        `对局 ${businessKey} 无法恢复（房间已丢失或适配器不支持 resume）；` +
          "已保留检查点，请显式重跑而不是自动新开一局。",
      );
    }
    if (restored.state.id !== businessKey) {
      throw new ResumeDivergedError(
        `恢复出的对局是 ${restored.state.id}，与检查点的 ${businessKey} 不一致`,
      );
    }
    observation = { state: restored.state, seq: checkpoint.lastObservationSeq, at: Date.now() };
    stepNo = checkpoint.nextStepNo;
    terminal = isTerminal(observation.state);
  } else {
    const opened = await options.adapter.open({ seed: options.seed });
    businessKey = opened.state.id;
    token = opened.token;
    observation = { state: opened.state, seq: 0, at: startedAt };
    stepNo = 0;
    terminal = isTerminal(observation.state);
  }

  const context: DriveContext = { businessKey, session, seed: options.seed };
  const save = (state: {
    nextStepNo: number;
    lastObservationSeq: number;
    pending?: PendingStep;
  }): void => {
    options.checkpoint?.save({
      schemaVersion: 1,
      scenario: options.scenario,
      seed: options.seed,
      adapter: options.adapter.name,
      governanceSource: options.governance.name,
      session,
      businessKey,
      token,
      startedAt,
      // 传快照而不是内部数组引用：写盘实现可能异步/保留引用，
      // 后续 push 不应让「崩溃前检查点」看到崩溃后的步。
      steps: [...steps],
      findings: [...findings],
      ...state,
    });
  };

  // --- 先把崩溃窗口里的 pending 步收尾 ---
  if (checkpoint?.pending) {
    const pending = checkpoint.pending;
    assertIdempotencyKey(pending.fingerprint);
    const beforeObservation = pending.beforeObservation;
    const currentHash = stateDigestOf(options.adapter, observation.state);
    const decision = decideResumeAction({
      currentHash,
      beforeHash: pending.beforeStateHash,
      ...(pending.expectedAfterHash ? { expectedAfterHash: pending.expectedAfterHash } : {}),
    });

    if (decision === "diverged") {
      throw new ResumeDivergedError(
        `续跑状态与检查点不一致：第 ${pending.stepNo} 步既不是执行前状态，也不是预期执行后状态。` +
          "已保留检查点，未自动猜测或重复执行。",
      );
    }

    if (decision === "replayed") {
      const execution: ExecutionResult = {
        outcome: "replayed",
        observationAfter: { state: observation.state, seq: pending.stepNo + 1, at: Date.now() },
        replayed: true,
        elapsedMs: 0,
        findings: [],
      };
      const violations = options.oracle.assert({
        before: beforeObservation,
        after: execution.observationAfter,
        action: pending.action,
        outcome: "applied",
      });
      pushViolations(findings, violations, pending.stepNo);
      if (violations.some((v) => v.severity === "fatal")) terminal = true;
      steps.push(recordOfPending(pending, execution));
      stepNo = pending.stepNo + 1;
      observation = { state: observation.state, seq: stepNo, at: Date.now() };
    } else {
      const execution = await executeAction({
        adapter: options.adapter,
        governance: options.governance,
        observation: { state: observation.state, seq: pending.stepNo, at: Date.now() },
        action: pending.action,
        context,
        stepNo: pending.stepNo,
        token,
        beforeStateHash: pending.beforeStateHash,
      });
      findings.push(...execution.findings);
      const violations = options.oracle.assert({
        before: beforeObservation,
        after: execution.observationAfter,
        action: pending.action,
        outcome: oracleOutcomeOf(execution),
      });
      pushViolations(findings, violations, pending.stepNo);
      if (violations.some((v) => v.severity === "fatal")) terminal = true;
      steps.push(recordOfPending(pending, execution));
      stepNo = pending.stepNo + 1;
      observation = execution.observationAfter
        ? { state: execution.observationAfter.state, seq: stepNo, at: Date.now() }
        : { state: observation.state, seq: stepNo, at: Date.now() };
    }

    save({ nextStepNo: stepNo, lastObservationSeq: observation.seq });
  }

  // --- 正常驱动循环 ---
  while (!terminal && stepNo < maxSteps) {
    const decision = await options.strategy.decide({ observation, seed: options.seed });
    const plan = planNextStep({ context, stepNo, observation, decision });
    if (plan.terminal) {
      terminal = true;
      break;
    }

    const action = plan.action!;
    assertIdempotencyKey(plan.fingerprint);
    const beforeStateHash = stateDigestOf(options.adapter, observation.state);
    const projected = options.adapter.projectAfter?.({ state: observation.state, action }) ?? null;
    const expectedAfterHash = projected ? stateDigestOf(options.adapter, projected) : undefined;

    const pending: PendingStep = {
      stepNo,
      action,
      reason: decision.reason,
      degraded: decision.degraded,
      ...(decision.degradedReason ? { degradedReason: decision.degradedReason } : {}),
      ...(decision.llmTokens !== undefined ? { llmTokens: decision.llmTokens } : {}),
      ...(decision.model ? { model: decision.model } : {}),
      fingerprint: plan.fingerprint,
      beforeObservation: observation,
      beforeStateHash,
      ...(expectedAfterHash ? { expectedAfterHash } : {}),
    };

    // 执行前先写 pending 意图 —— 崩溃注入点在 act 之后、committed 之前，
    // 恢复时靠 before/expectedAfter 两个哈希判定该步到底生效没有。
    save({ nextStepNo: stepNo, lastObservationSeq: observation.seq, pending });

    const execution = await executeAction({
      adapter: options.adapter,
      governance: options.governance,
      observation,
      action,
      context,
      stepNo,
      token,
      beforeStateHash,
    });
    findings.push(...execution.findings);

    const violations = options.oracle.assert({
      before: observation,
      after: execution.observationAfter,
      action,
      outcome: oracleOutcomeOf(execution),
    });
    pushViolations(findings, violations, stepNo);
    if (violations.some((v) => v.severity === "fatal")) terminal = true;

    steps.push({
      stepNo,
      fingerprint: plan.fingerprint,
      observation,
      action,
      reason: decision.reason,
      degraded: decision.degraded,
      ...(decision.degradedReason ? { degradedReason: decision.degradedReason } : {}),
      ...(decision.llmTokens !== undefined ? { llmTokens: decision.llmTokens } : {}),
      ...(decision.model ? { model: decision.model } : {}),
      outcome: execution.outcome,
      observationAfter: execution.observationAfter,
      ...(execution.error ? { error: execution.error } : {}),
      governance: governanceOf(execution),
      elapsedMs: execution.elapsedMs,
    });

    // --- 崩溃注入（模拟"副作用已发生、检查点未提交"） ---
    if (options.injectCrashAfterStep === stepNo) {
      throw new InjectedCrash(stepNo);
    }

    if (execution.observationAfter) {
      observation = { state: execution.observationAfter.state, seq: stepNo + 1, at: Date.now() };
    } else {
      observation = { ...observation, seq: stepNo + 1, at: Date.now() };
    }
    stepNo += 1;

    save({ nextStepNo: stepNo, lastObservationSeq: observation.seq });
  }

  // 正常收口：检查点不再需要（崩溃路径不会走到这里）。
  options.checkpoint?.remove();

  const meta = driveMeta(steps, terminal);
  return {
    scenario: options.scenario,
    session,
    businessKey,
    seed: options.seed,
    startedAt,
    finishedAt: Date.now(),
    steps,
    findings,
    terminal: meta.terminal,
  };
}

function validateResume(options: DriveOptions, checkpoint: Checkpoint): void {
  if (checkpoint.scenario !== options.scenario) {
    throw new ResumeDivergedError(
      `检查点场景是 "${checkpoint.scenario}"，本次是 "${options.scenario}"`,
    );
  }
  if (checkpoint.seed !== options.seed) {
    throw new ResumeDivergedError(`检查点 seed 是 ${checkpoint.seed}，本次是 ${options.seed}`);
  }
  if (checkpoint.adapter !== options.adapter.name) {
    throw new ResumeDivergedError(
      `检查点适配器是 "${checkpoint.adapter}"，本次是 "${options.adapter.name}"`,
    );
  }
  if (checkpoint.governanceSource !== options.governance.name) {
    throw new ResumeDivergedError(
      `检查点治理来源是 "${checkpoint.governanceSource}"，本次是 "${options.governance.name}"；` +
        "续跑必须复用同一治理口径",
    );
  }
  if (checkpoint.pending && checkpoint.nextStepNo !== checkpoint.pending.stepNo) {
    throw new ResumeDivergedError(
      `检查点不一致：nextStepNo=${checkpoint.nextStepNo}，pending.stepNo=${checkpoint.pending.stepNo}`,
    );
  }
}

function stateDigestOf(adapter: GameAdapter, state: GameState): string {
  return adapter.stateDigest?.({ state }) ?? stateHashOf(state);
}

function oracleOutcomeOf(execution: ExecutionResult): StepOutcome {
  // 重放步如果拿到了 post-state，就用 applied 让断言真正校验这次状态转移；
  // 拿不到 post-state 时保持 replayed，避免 Oracle 在空状态上误判。
  return execution.outcome === "replayed" && execution.observationAfter
    ? "applied"
    : execution.outcome;
}

function governanceOf(execution: ExecutionResult): StepRecord["governance"] {
  return {
    replayed: execution.replayed,
    elapsedMs: execution.elapsedMs,
    ...(execution.traceId ? { traceId: execution.traceId } : {}),
    ...(execution.tokens !== undefined ? { tokens: execution.tokens } : {}),
    ...(execution.tokenSource ? { tokenSource: execution.tokenSource } : {}),
    ...(execution.tokensUnavailableReason
      ? { tokensUnavailableReason: execution.tokensUnavailableReason }
      : {}),
  };
}

function recordOfPending(pending: PendingStep, execution: ExecutionResult): StepRecord {
  return {
    stepNo: pending.stepNo,
    fingerprint: pending.fingerprint,
    observation: pending.beforeObservation,
    action: pending.action,
    reason: pending.reason,
    degraded: pending.degraded,
    ...(pending.degradedReason ? { degradedReason: pending.degradedReason } : {}),
    ...(pending.llmTokens !== undefined ? { llmTokens: pending.llmTokens } : {}),
    ...(pending.model ? { model: pending.model } : {}),
    outcome: execution.outcome,
    observationAfter: execution.observationAfter,
    ...(execution.error ? { error: execution.error } : {}),
    governance: governanceOf(execution),
    elapsedMs: execution.elapsedMs,
  };
}

function pushViolations(
  findings: Finding[],
  violations: readonly OracleViolation[],
  stepNo: number,
): void {
  for (const violation of violations) {
    findings.push({
      code: violation.code,
      severity: violation.severity,
      message: violation.message,
      stepNo: violation.stepNo ?? stepNo,
    });
  }
}

/**
 * 执行一步：治理幂等 → 适配器动作 →（重放时）观察核对。
 */
async function executeAction(params: {
  readonly adapter: GameAdapter;
  readonly governance: GovernanceClient;
  readonly observation: Observation;
  readonly action: Action;
  readonly context: DriveContext;
  readonly stepNo: number;
  readonly token: string;
  readonly beforeStateHash: string;
}): Promise<ExecutionResult> {
  const started = Date.now();
  const findings: Finding[] = [];
  let observationAfter: Observation | null = null;
  let replayed = false;
  let traceId: string | undefined;
  let tokens: number | undefined;
  let tokenSource: TokenSource | undefined;
  let tokensUnavailableReason: string | undefined;

  try {
    const result = await params.governance.invoke({
      businessKey: params.context.businessKey,
      session: params.context.session,
      stepNo: params.stepNo,
      action: params.action.payload,
      perform: async () => {
        const acted = await params.adapter.act({
          state: params.observation.state,
          token: params.token,
          action: params.action,
        });
        if (!acted.ok) throw new Error(acted.error ?? "动作执行失败");
        observationAfter = acted.observation ?? null;
      },
    });

    replayed = result.replayed;
    traceId = result.traceId;
    tokens = result.tokens;
    tokenSource = result.tokenSource;
    tokensUnavailableReason = result.tokensUnavailableReason;

    if (replayed) {
      const observed = await observeAfterReplay(params);
      if (!observed) {
        findings.push({
          code: "G6-replayed-observation-unavailable",
          severity: "warning",
          message: "治理侧报告重放，但无法观察当前局面；该步按重放记录，未伪造 post-state。",
          stepNo: params.stepNo,
        });
        return {
          outcome: "replayed",
          observationAfter: null,
          replayed: true,
          ...(traceId ? { traceId } : {}),
          ...(tokens !== undefined ? { tokens } : {}),
          ...(tokenSource ? { tokenSource } : {}),
          ...(tokensUnavailableReason ? { tokensUnavailableReason } : {}),
          elapsedMs: Date.now() - started,
          findings,
        };
      }

      observationAfter = observed;
      const currentHash = stateDigestOf(params.adapter, observed.state);
      if (currentHash === params.beforeStateHash) {
        // 治理侧已记成功，但游戏状态仍是执行前 —— 不能静默跳过，补偿执行游戏动作。
        const repaired = await params.adapter.act({
          state: params.observation.state,
          token: params.token,
          action: params.action,
        });
        if (!repaired.ok) throw new Error(repaired.error ?? "重放补偿执行失败");
        observationAfter = repaired.observation ?? observed;
        findings.push({
          code: "G7-governance-replayed-before-game-state",
          severity: "warning",
          message:
            "治理侧报告重放，但游戏局面仍是执行前状态；已补偿执行该动作并如实记录（治理账与游戏副作用曾短暂不一致）。",
          stepNo: params.stepNo,
        });
        return {
          outcome: "applied",
          observationAfter,
          replayed: true,
          ...(traceId ? { traceId } : {}),
          ...(tokens !== undefined ? { tokens } : {}),
          ...(tokenSource ? { tokenSource } : {}),
          ...(tokensUnavailableReason ? { tokensUnavailableReason } : {}),
          elapsedMs: Date.now() - started,
          findings,
        };
      }
    }

    return {
      outcome: replayed ? "replayed" : "applied",
      observationAfter,
      replayed,
      ...(traceId ? { traceId } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
      ...(tokenSource ? { tokenSource } : {}),
      ...(tokensUnavailableReason ? { tokensUnavailableReason } : {}),
      elapsedMs: Date.now() - started,
      findings,
    };
  } catch (error) {
    return {
      outcome: "failed",
      observationAfter: null,
      error: error instanceof Error ? error.message : String(error),
      replayed: false,
      elapsedMs: Date.now() - started,
      findings,
    };
  }
}

async function observeAfterReplay(params: {
  readonly adapter: GameAdapter;
  readonly observation: Observation;
  readonly token: string;
  readonly stepNo: number;
}): Promise<Observation | null> {
  try {
    const observed = await params.adapter.observe({
      state: params.observation.state,
      token: params.token,
    });
    // observation.seq 由驱动自己维护（= stepNo + 1），避免适配器按服务端
    // moveCount 自增导致重放后序号跳变。
    return { state: observed.state, seq: params.stepNo + 1, at: Date.now() };
  } catch {
    return null;
  }
}
