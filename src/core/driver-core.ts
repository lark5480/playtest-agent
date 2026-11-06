/**
 * 纯函数内核 · 驱动循环骨架（地基冻结契约 ④ 的载体）
 *
 * 这一层**不做 IO**：它只回答"下一步该做什么"，真正的观察 / 执行由
 * `GameAdapter` 与 `Strategy` 提供。分离的意义：
 * - 驱动逻辑可被纯单测覆盖（给定状态序列，断言动作序列）；
 * - 驱动循环的形状与 aiwarden 的 DAG **解耦**（本项目只进程外消费其治理能力）。
 *
 * 循环形状（与 aiwarden 的单次 DAG 不同，这里是循环）：
 *   observe → decide → act → observe → …
 */

import type { Action, Decision, GameState, Observation } from "../types/game.js";
import type { IdempotencyFingerprint } from "../types/step.js";

import { canonicalize, computeFingerprint } from "./fingerprint.js";

/**
 * 驱动上下文：一次 playtest 运行的常量部分。
 */
export interface DriveContext {
  /** 对局标识（房间码 / session id）——进幂等键。 */
  readonly businessKey: string;
  /** 运行标识 ——进幂等键。 */
  readonly session: string;
  /** 随机种子 —— 写进报告，保证可复现。 */
  readonly seed: number;
}

/**
 * 驱动上下文的派生信息（纯计算）。
 */
export interface DriveMeta {
  /** 已执行的步数。 */
  readonly stepCount: number;
  /** 是否已到终局。 */
  readonly terminal: boolean;
}

/**
 * 计算下一步的幂等指纹。
 *
 * 指纹的输入只有"业务键 + 会话 + 步骤序号 + 动作内容"，
 * **不含时间、不含随机数** —— 这保证了续跑时能算出与上次完全相同的键。
 */
export function nextFingerprint(
  context: DriveContext,
  stepNo: number,
  action: Action | null,
): IdempotencyFingerprint {
  return computeFingerprint({
    businessKey: context.businessKey,
    session: context.session,
    stepNo,
    action,
  });
}

/**
 * 判断对局是否已终止。
 *
 * 只描述游戏状态；停滞、步限、断言失败属于独立的驱动停止原因。
 */
export function isTerminal(state: GameState): boolean {
  return state.status === "finished";
}

/**
 * 决定下一步：把"当前观察 + 策略决策"收敛成一次可执行的步。
 *
 * 终止判定放在这里（而不是驱动循环里），是为了让"何时停"也是纯逻辑、可单测。
 */
export function planNextStep(params: {
  readonly context: DriveContext;
  readonly stepNo: number;
  readonly observation: Observation;
  readonly decision: Decision;
}): {
  readonly stepNo: number;
  readonly action: Action | null;
  readonly fingerprint: IdempotencyFingerprint;
  readonly terminal: boolean;
} {
  const { context, stepNo, observation, decision } = params;
  const terminal = isTerminal(observation.state);

  if (terminal) {
    return {
      stepNo,
      action: null,
      fingerprint: nextFingerprint(context, stepNo, null),
      terminal: true,
    };
  }

  // 策略给了动作，但必须落在"合法动作集"内 —— Agent 不允许臆造动作。
  // 这条约束是 Oracle 能抓到"策略越界"类缺陷的前提。
  const action = decision.action;
  if (action === null) throw new Error("策略在非终局返回空动作");
  const payload = JSON.stringify(canonicalize(action.payload));
  const legal = observation.state.legalActions.some(
    (candidate) =>
      candidate.id === action.id && JSON.stringify(canonicalize(candidate.payload)) === payload,
  );
  if (!legal) throw new Error("策略返回了非法动作：ID 与完整 payload 必须同时匹配合法动作集");

  return {
    stepNo,
    action,
    fingerprint: nextFingerprint(context, stepNo, action),
    terminal: action === null,
  };
}

/**
 * 汇总驱动元信息（纯计算）。
 */
export function driveMeta(
  steps: readonly { readonly action: Action | null }[],
  terminal: boolean,
): DriveMeta {
  return { stepCount: steps.length, terminal };
}
