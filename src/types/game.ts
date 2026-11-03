/**
 * 共享类型 · 对局与动作（地基冻结契约 ①）
 *
 * 本文件是全项目对"什么是一局、什么是一个动作"的唯一定义。
 * 冻结后只允许向后兼容地扩展字段，不允许改变既有字段的含义或类型。
 */

/**
 * 对局状态。
 *
 * 刻意**不携带**任何游戏专有字段：游戏专有信息放 `payload`，
 * 由适配器自行解释。这样 Agent 核心（驱动 / 治理 / 报告）不依赖任何具体游戏。
 */
export interface GameState {
  /** 对局唯一标识（房间码 / session id）。 */
  readonly id: string;
  /** 对局阶段。 */
  readonly status: GameStatus;
  /** 当前轮到谁行动（玩家标识；终止态为 null）。 */
  readonly turn: string | null;
  /** 当前状态下**全部**合法动作。Agent 只从中挑选，不自行臆造。 */
  readonly legalActions: readonly Action[];
  /** 游戏专有状态（棋盘 / 题目集 / …），由适配器解释。 */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** 对局阶段。 */
export type GameStatus = "waiting" | "playing" | "finished";

/**
 * 一个可执行动作。
 *
 * `payload` 是**规范化**后的动作内容（键已排序），它参与幂等指纹计算——
 * 因此同样的语义动作必须产出同样的 payload，否则续跑会认不出重放。
 */
export interface Action {
  /** 动作在当前状态下的稳定标识（用于日志与报告，不参与指纹计算）。 */
  readonly id: string;
  /** 动作的规范化内容，参与指纹计算。 */
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * 一次观察：Agent 在决策前看到的局面。
 */
export interface Observation {
  /** 被观察的对局状态。 */
  readonly state: GameState;
  /** 观察发生的单调递增序号（从 0 起），用于时序断言。 */
  readonly seq: number;
  /** 观察时刻（毫秒时间戳，由调用方注入，核心层不自己读时钟）。 */
  readonly at: number;
}

/**
 * 决策结果：策略层给出的一次选择。
 */
export interface Decision {
  /** 选中的动作；null 表示"无可行动作"（应触发终止判定）。 */
  readonly action: Action | null;
  /** 决策理由（写进报告，用于复盘"为什么这么走"）。 */
  readonly reason: string;
  /** 本次决策是否走了降级路径（模型不可用 → 确定性基线）。 */
  readonly degraded: boolean;
  /** 降级原因（degraded 为 true 时必填）。 */
  readonly degradedReason?: string;
}
