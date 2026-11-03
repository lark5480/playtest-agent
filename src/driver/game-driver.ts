/**
 * 驱动层 · GameDriver
 *
 * 把地基组装起来：观察 → 决策 → 执行 → 断言 → 记录 → 下一轮。
 *
 * 这一层**做 IO**（调适配器、策略、治理），但**不含业务规则**——
 * 规则全在 `core/` 的纯函数里。这样驱动层很薄，业务逻辑可单测。
 */

import { driveMeta, isTerminal, nextFingerprint, planNextStep } from "../core/driver-core.js";
import type { DriveContext } from "../core/driver-core.js";
import type { Finding } from "../core/report-core.js";
import type { GameAdapter } from "../adapter/game-adapter.js";
import type { GovernanceClient } from "../types/governance.js";
import type { Action, GameState, Observation } from "../types/game.js";
import type { Oracle, OracleViolation } from "../oracle/oracle.js";
import type { Strategy } from "../strategy/strategy.js";
import type { StepOutcome, StepRecord } from "../types/step.js";

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
  /**
   * 续跑：复用上次的凭证与已完成的步数。
   *
   * 语义：从 `startStepNo` 继续，**已完成的步骤不重做**；
   * 崩溃点那一步会重做，但幂等键命中终态 → 不产生第二次副作用。
   */
  readonly resume?: {
    readonly token: string;
    readonly startStepNo: number;
    readonly lastAction?: Action | null;
  };
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
 * 驱动执行一次场景。
 *
 * @throws InjectedCrash 当命中注入点（用于验证续跑 —— 崩溃后应能接着跑）。
 */
export async function drive(options: DriveOptions): Promise<DriveResult> {
  const maxSteps = options.maxSteps ?? 200;
  const startedAt = Date.now();
  const session = `pt-${options.scenario}-${options.seed}`;
  const steps: StepRecord[] = [];
  const findings: Finding[] = [];

  const opened = options.resume
    ? await thisResume(options)
    : await options.adapter.open({ seed: options.seed });
  const businessKey = opened.state.id;
  const context: DriveContext = { businessKey, session, seed: options.seed };

  let observation: Observation = {
    state: opened.state,
    seq: 0,
    at: startedAt,
  };
  let terminal = isTerminal(observation.state);
  // 续跑时从断点继续；新跑时从 0 开始。
  let stepNo = options.resume?.startStepNo ?? 0;

  while (!terminal && stepNo < maxSteps) {
    const stepStart = Date.now();

    // --- 决策 ---
    const decision = await options.strategy.decide({ observation, seed: options.seed });

    // --- 纯逻辑：规划本步（校验动作合法性、算指纹） ---
    const plan = planNextStep({ context, stepNo, observation, decision });
    if (plan.terminal) {
      terminal = true;
      break;
    }

    // --- 执行（经治理管道，幂等） ---
    const action = plan.action!;
    let outcome: StepOutcome = "applied";
    let observationAfter: Observation | null = null;
    let error: string | undefined;
    let replayed = false;
    let traceId: string | undefined;
    let tokens: number | undefined;

    try {
      const governance = await options.governance.invoke({
        businessKey,
        session,
        stepNo,
        action: action.payload,
        perform: async () => {
          const result = await options.adapter.act({
            state: observation.state,
            token: opened.token,
            action,
          });
          if (!result.ok) {
            throw new Error(result.error ?? "动作执行失败");
          }
          observationAfter = result.observation ?? null;
        },
      });
      replayed = governance.replayed;
      traceId = governance.traceId;
      tokens = governance.tokens;
    } catch (error_) {
      outcome = "failed";
      error = error_ instanceof Error ? error_.message : String(error_);
    }

    // --- 断言 ---
    const violations: readonly OracleViolation[] = options.oracle.assert({
      before: observation,
      after: observationAfter,
      action,
      outcome,
    });
    for (const v of violations) {
      findings.push({
        code: v.code,
        severity: v.severity,
        message: v.message,
        stepNo: v.stepNo ?? stepNo,
      });
      if (v.severity === "fatal") {
        terminal = true;
      }
    }

    // --- 记录 ---
    steps.push({
      stepNo,
      fingerprint: nextFingerprint(context, stepNo, action),
      observation,
      action,
      reason: decision.reason,
      degraded: decision.degraded,
      ...(decision.degradedReason ? { degradedReason: decision.degradedReason } : {}),
      outcome,
      observationAfter,
      ...(error ? { error } : {}),
      governance: {
        replayed,
        elapsedMs: Date.now() - stepStart,
        ...(traceId ? { traceId } : {}),
        ...(tokens !== undefined ? { tokens } : {}),
      },
      elapsedMs: Date.now() - stepStart,
    });

    // --- 崩溃注入（模拟"副作用已发生、检查点未提交"） ---
    if (options.injectCrashAfterStep === stepNo) {
      throw new InjectedCrash(stepNo);
    }

    if (observationAfter) {
      observation = observationAfter;
    }
    stepNo += 1;
  }

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

/**
 * 续跑入口：优先从凭证恢复对局；恢复不了（游戏进程重启）则重建一局。
 *
 * 重建时**动作会被重放**——靠幂等键保证不产生第二次副作用。
 */
async function thisResume(options: DriveOptions): Promise<{ state: GameState; token: string }> {
  const resume = options.resume!;
  if (options.adapter.resume) {
    const restored = await options.adapter.resume({ token: resume.token });
    if (restored) {
      return { state: restored.state, token: resume.token };
    }
  }
  // 对局不可恢复 → 重建（后续动作靠幂等键去重）
  return options.adapter.open({ seed: options.seed });
}
