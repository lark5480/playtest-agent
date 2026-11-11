/**
 * 驱动层 · GameDriver
 *
 * 把地基组装起来：观察 → 决策 → 执行 → 断言 → 记录 → 下一轮。
 *
 * 这一层**做 IO**（调适配器、策略、治理、检查点），但**不含业务规则**——
 * 规则全在 `core/` 的纯函数里。这样驱动层很薄，业务逻辑可单测。
 */

import { randomUUID } from "node:crypto";
import { isTerminal, planNextStep, nextFingerprint } from "../core/driver-core.js";
import type { ModelBudgetState, RunBudget } from "../types/budget.js";
import { StrategyStop } from "../types/run.js";
import type { ErrorCategory, GameKind, StopReason } from "../types/run.js";
import type { DriveContext } from "../core/driver-core.js";
import type { Finding } from "../core/report-core.js";
import { decideResumeAction } from "../core/resume.js";
import { stateHashOf } from "../core/state-hash.js";
import { assertIdempotencyKey } from "../governance/idempotency.js";
import { GovernanceDeniedError } from "../governance/errors.js";
import type { GameAdapter } from "../adapter/game-adapter.js";
import type { GovernanceClient } from "../types/governance.js";
import type { Action, GameState, Observation } from "../types/game.js";
import type { Oracle, OracleViolation } from "../oracle/oracle.js";
import type { Strategy } from "../strategy/strategy.js";
import type {
  StepErrorCode,
  StepOutcome,
  StepRecord,
  TokenSource,
  TokenUnavailableReasonCode,
} from "../types/step.js";
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
  readonly session?: string;
  readonly budget?: RunBudget;
  readonly exploration?: { readonly game: GameKind; readonly target: string };
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
  readonly initialState: GameState;
  readonly finalState: GameState;
  readonly stopReason: StopReason;
  readonly gameTerminal: boolean;
  readonly errorCategory?: ErrorCategory;
  readonly budget?: ModelBudgetState;
  /** 兼容字段，只等于 gameTerminal，不表示驱动成功完成。 */
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
  readonly error?: StepErrorCode;
  readonly errorCategory?: ErrorCategory;
  readonly replayed: boolean;
  readonly traceId?: string;
  readonly tokens?: number;
  readonly tokenSource?: TokenSource;
  readonly tokensUnavailableReason?: TokenUnavailableReasonCode;
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
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 0) throw new Error("maxSteps 必须是非负整数");
  const checkpoint = options.resume;
  if (checkpoint) validateResume(options, checkpoint);
  const session = checkpoint?.session ?? options.session ?? randomUUID();
  const startedAt = checkpoint?.startedAt ?? Date.now();
  const steps: StepRecord[] = checkpoint ? [...checkpoint.steps] : [];
  const findings: Finding[] = checkpoint ? [...checkpoint.findings] : [];
  let businessKey: string;
  let token: string;
  let observation: Observation;
  let stepNo = checkpoint?.nextStepNo ?? 0;
  let pending = checkpoint?.pending;
  let stopReason: StopReason | undefined;
  let errorCategory: ErrorCategory | undefined;

  if (checkpoint) {
    businessKey = checkpoint.businessKey;
    token = checkpoint.token;
    let restored;
    try {
      restored = await options.adapter.resume?.({ token });
    } catch {
      throw new ResumeUnavailableError("对局恢复请求失败；已保留检查点，未新开对局");
    }
    if (!restored) throw new ResumeUnavailableError("对局无法恢复；已保留检查点，未新开对局");
    if (restored.state.id !== businessKey)
      throw new ResumeDivergedError("恢复出的对局与检查点不一致");
    observation = { state: restored.state, seq: checkpoint.lastObservationSeq, at: Date.now() };
  } else {
    const opened = await options.adapter.open({ seed: options.seed });
    businessKey = opened.state.id;
    token = opened.token;
    observation = { state: opened.state, seq: 0, at: startedAt };
  }
  const initialState = checkpoint?.initialState ?? observation.state;
  const context: DriveContext = { businessKey, session, seed: options.seed };
  // 闭包始终读取当前意图与确认前缀；预算预扣/结算在请求边界同步保存。
  const save = (): void => {
    const budget = options.budget?.snapshot() ?? checkpoint?.budget;
    const pendingNo = pending?.stepNo;
    options.checkpoint?.save({
      schemaVersion: 2,
      scenario: options.scenario,
      seed: options.seed,
      adapter: options.adapter.name,
      governanceSource: options.governance.name,
      session,
      businessKey,
      token,
      startedAt,
      initialState,
      nextStepNo: stepNo,
      lastObservationSeq: pending ? pending.beforeObservation.seq : observation.seq,
      steps: pendingNo === undefined ? [...steps] : steps.filter((step) => step.stepNo < pendingNo),
      findings: [...findings],
      ...(pending ? { pending } : {}),
      ...(budget ? { budget } : {}),
    });
  };
  options.budget?.bindPersistence(save);
  const checkState = (): void => {
    pushViolations(
      findings,
      options.oracle.assert({
        before: observation,
        after: observation,
        action: null,
        outcome: "applied",
      }),
      steps.length === 0 ? null : steps[steps.length - 1]!.stepNo,
    );
  };
  const stateStop = (): StopReason | undefined => {
    if (findings.some((finding) => finding.severity === "fatal")) return "assertion-failed";
    if (isTerminal(observation.state)) return "game-finished";
    if (
      observation.state.status !== "playing" ||
      observation.state.turn === null ||
      observation.state.legalActions.length === 0
    )
      return "stalled";
    return undefined;
  };
  if (checkpoint && !pending) {
    const expected = steps[steps.length - 1]?.observationAfter?.state ?? initialState;
    if (
      stateDigestOf(options.adapter, expected) !== stateDigestOf(options.adapter, observation.state)
    )
      throw new ResumeDivergedError("恢复状态与已提交检查点不一致；未执行动作");
  }

  // pending 优先收尾，绝不重新询问策略或扣模型调用数。
  if (pending) {
    assertIdempotencyKey(pending.fingerprint);
    try {
      planNextStep({
        context,
        stepNo: pending.stepNo,
        observation: pending.beforeObservation,
        decision: { action: pending.action, reason: pending.reason, degraded: pending.degraded },
      });
      if (
        stateDigestOf(options.adapter, pending.beforeObservation.state) !== pending.beforeStateHash
      )
        throw new Error();
    } catch {
      throw new ResumeDivergedError("pending 动作或前置状态无效");
    }
    const expected = nextFingerprint(context, pending.stepNo, pending.action);
    if (
      expected.digest !== pending.fingerprint.digest ||
      expected.session !== pending.fingerprint.session ||
      expected.businessKey !== pending.fingerprint.businessKey ||
      expected.stepNo !== pending.fingerprint.stepNo
    )
      throw new ResumeDivergedError("pending 动作与幂等指纹不一致");
    const decision = decideResumeAction({
      currentHash: stateDigestOf(options.adapter, observation.state),
      beforeHash: pending.beforeStateHash,
      ...(pending.expectedAfterHash ? { expectedAfterHash: pending.expectedAfterHash } : {}),
    });
    if (decision === "diverged")
      throw new ResumeDivergedError("续跑状态既非执行前也非预期执行后；已保留检查点");
    if (decision === "replayed") {
      const execution: ExecutionResult = {
        outcome: "replayed",
        observationAfter: { ...observation, seq: pending.stepNo + 1 },
        replayed: true,
        elapsedMs: 0,
        findings: [],
      };
      pushViolations(
        findings,
        options.oracle.assert({
          before: pending.beforeObservation,
          after: execution.observationAfter,
          action: pending.action,
          outcome: "applied",
        }),
        pending.stepNo,
      );
      steps.push(recordOfPending(pending, execution));
      observation = execution.observationAfter!;
      stepNo = pending.stepNo + 1;
      pending = undefined;
      save();
    } else if (!options.adapter.supportsConditionalAct) {
      stopReason = "execution-failed";
      errorCategory = "game";
    } else {
      checkState();
      stopReason = stateStop();
      if (!stopReason) {
        const execution = await executeAction({
          adapter: options.adapter,
          governance: options.governance,
          observation,
          action: pending.action,
          context,
          stepNo,
          token,
          beforeStateHash: pending.beforeStateHash,
          ...(pending.expectedAfterHash ? { expectedAfterHash: pending.expectedAfterHash } : {}),
        });
        findings.push(...execution.findings);
        pushViolations(
          findings,
          options.oracle.assert({
            before: pending.beforeObservation,
            after: execution.observationAfter,
            action: pending.action,
            outcome: oracleOutcomeOf(execution),
          }),
          pending.stepNo,
        );
        steps.push(recordOfPending(pending, execution));
        if (execution.observationAfter) observation = execution.observationAfter;
        if (execution.outcome === "failed" || execution.outcome === "rejected") {
          stopReason = "execution-failed";
          errorCategory = execution.errorCategory ?? "game";
        } else {
          stepNo = pending.stepNo + 1;
          pending = undefined;
        }
        save();
      }
    }
  }

  checkState();
  stopReason ??= stateStop();
  save();
  while (!stopReason && stepNo < maxSteps) {
    const stepStarted = Date.now();
    let plan;
    let decision;
    try {
      const exploration = options.exploration
        ? (await import("../core/exploration.js")).explorationContext(
            options.exploration.game,
            options.exploration.target,
            steps,
          )
        : undefined;
      decision = await options.strategy.decide({
        observation,
        seed: options.seed,
        ...(exploration ? { exploration } : {}),
      });
      plan = planNextStep({ context, stepNo, observation, decision });
    } catch (error) {
      if (error instanceof StrategyStop) {
        stopReason = error.stopReason;
        errorCategory =
          error.stopReason === "budget-limit"
            ? "budget"
            : error.stopReason === "state-diverged"
              ? "state"
              : undefined;
      } else {
        stopReason = "strategy-stopped";
        errorCategory = "strategy";
      }
      break;
    }
    const action = plan.action!;
    assertIdempotencyKey(plan.fingerprint);
    const beforeStateHash = stateDigestOf(options.adapter, observation.state);
    const projected = options.adapter.projectAfter?.({ state: observation.state, action }) ?? null;
    const expectedAfterHash = projected ? stateDigestOf(options.adapter, projected) : undefined;
    pending = {
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
    save(); // 写失败直接抛出，不得继续执行副作用。
    const execution = await executeAction({
      adapter: options.adapter,
      governance: options.governance,
      observation,
      action,
      context,
      stepNo,
      token,
      beforeStateHash,
      ...(expectedAfterHash ? { expectedAfterHash } : {}),
    });
    findings.push(...execution.findings);
    pushViolations(
      findings,
      options.oracle.assert({
        before: observation,
        after: execution.observationAfter,
        action,
        outcome: oracleOutcomeOf(execution),
      }),
      stepNo,
    );
    steps.push({ ...recordOfPending(pending, execution), elapsedMs: Date.now() - stepStarted });
    if (options.injectCrashAfterStep === stepNo) throw new InjectedCrash(stepNo);
    if (execution.observationAfter) observation = execution.observationAfter;
    if (execution.outcome === "failed" || execution.outcome === "rejected") {
      stopReason = "execution-failed";
      errorCategory = execution.errorCategory ?? "game";
      // 保留原步号、pending 与确认前缀，续跑只能收尾该动作。
    } else {
      stepNo += 1;
      pending = undefined;
      stopReason = stateStop();
    }
    save();
  }
  checkState();
  if (findings.some((finding) => finding.severity === "fatal") && stopReason !== "execution-failed")
    stopReason = "assertion-failed";
  stopReason ??= stateStop() ?? "step-limit";
  if (stopReason === "assertion-failed" || stopReason === "stalled") errorCategory ??= "state";
  save(); // 由 CLI 在报告持久化且正常完成后负责 remove。
  const gameTerminal = isTerminal(observation.state);
  const budget = options.budget?.snapshot() ?? checkpoint?.budget;
  return {
    scenario: options.scenario,
    session,
    businessKey,
    seed: options.seed,
    startedAt,
    finishedAt: Date.now(),
    steps,
    findings,
    initialState,
    finalState: observation.state,
    stopReason,
    gameTerminal,
    terminal: gameTerminal,
    ...(errorCategory ? { errorCategory } : {}),
    ...(budget ? { budget } : {}),
  };
}

function validateResume(options: DriveOptions, checkpoint: Checkpoint): void {
  if (checkpoint.schemaVersion !== 2)
    throw new ResumeDivergedError("检查点 schemaVersion 不兼容；必须是 2");
  if (options.session && options.session !== checkpoint.session)
    throw new ResumeDivergedError("检查点 session 不一致");
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
  stepNo: number | null,
): void {
  for (const violation of violations) {
    const no = violation.stepNo ?? stepNo;
    if (findings.some((finding) => finding.code === violation.code && finding.stepNo === no))
      continue;
    findings.push({
      code: violation.code,
      severity: violation.severity,
      message: violation.message,
      stepNo: no,
      ...(violation.evidence ? { evidence: violation.evidence } : {}),
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
  readonly expectedAfterHash?: string;
}): Promise<ExecutionResult> {
  const started = Date.now();
  const findings: Finding[] = [];
  let observationAfter: Observation | null = null;
  let replayed = false;
  let traceId: string | undefined;
  let tokens: number | undefined;
  let tokenSource: TokenSource | undefined;
  let tokensUnavailableReason: TokenUnavailableReasonCode | undefined;
  let errorCategory: ErrorCategory = "governance";
  // 失败时落到哪个闭合原因码；原始错误文本不入报告。
  let failureCode: StepErrorCode = "governance-error";

  try {
    const result = await params.governance.invoke({
      businessKey: params.context.businessKey,
      session: params.context.session,
      stepNo: params.stepNo,
      action: params.action.payload,
      perform: async () => {
        errorCategory = "game";
        failureCode = "game-request-failed";
        const acted = await params.adapter.act({
          state: params.observation.state,
          token: params.token,
          action: params.action,
        });
        failureCode = "game-action-unconfirmed";
        if (!acted.ok || !acted.observation) throw new Error("动作及后置状态未确认");
        observationAfter = { ...acted.observation, seq: params.stepNo + 1 };
      },
    });

    replayed = result.replayed;
    traceId = result.traceId;
    tokens = result.tokens;
    tokenSource = result.tokenSource;
    tokensUnavailableReason = result.tokensUnavailableReason;

    if (replayed) {
      errorCategory = "game";
      failureCode = "game-request-failed";
      const observed = await observeAfterReplay(params);
      if (!observed) {
        failureCode = "replay-unobservable";
        throw new Error("治理重放但后置状态无法观察");
      }
      const currentHash = stateDigestOf(params.adapter, observed.state);
      const decision = decideResumeAction({
        currentHash,
        beforeHash: params.beforeStateHash,
        ...(params.expectedAfterHash ? { expectedAfterHash: params.expectedAfterHash } : {}),
      });
      if (decision === "diverged") {
        failureCode = "replay-diverged";
        errorCategory = "state";
        throw new Error("重放状态发散");
      }
      if (decision === "replayed") observationAfter = observed;
      if (decision === "redo") {
        if (!params.adapter.supportsConditionalAct) {
          failureCode = "conditional-retry-unsupported";
          throw new Error("适配器不支持安全条件重试");
        }
        const repaired = await params.adapter.act({
          state: observed.state,
          token: params.token,
          action: params.action,
        });
        if (!repaired.ok || !repaired.observation) {
          failureCode = "replay-compensation-failed";
          throw new Error("重放补偿未确认");
        }
        observationAfter = { ...repaired.observation, seq: params.stepNo + 1 };
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

    if (!observationAfter) {
      failureCode = "missing-post-state";
      throw new Error("缺少后置状态");
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
    // 治理拒绝（待审批 / 已驳回）与网络故障可辨（裁决 37）；原始错误文本仍不入报告。
    if (error instanceof GovernanceDeniedError) failureCode = "governance-denied";
    return {
      outcome: "failed",
      observationAfter,
      error: failureCode,
      errorCategory,
      replayed,
      ...(traceId ? { traceId } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
      ...(tokenSource ? { tokenSource } : {}),
      ...(tokensUnavailableReason ? { tokensUnavailableReason } : {}),
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
