/**
 * 适配器 SPI（地基冻结契约 ④）
 *
 * 一个游戏 = 一个适配器。适配器是**游戏专属**的，不进 aiwarden，
 * 也不被 Agent 核心直接依赖（核心只认本接口）。
 *
 * 契约（冻结）：方法签名不得变更。新增能力请新增可选方法 + 默认实现。
 */

import type { Action, GameState, Observation } from "../types/game.js";

/**
 * 游戏适配器。
 *
 * 实现方负责把"某个具体游戏"翻译成 Agent 能理解的动作与观察。
 */
export interface GameAdapter {
  /** 适配器标识（写进报告，便于区分被测对象）。 */
  readonly name: string;

  /**
   * 开一局。
   *
   * @returns 新对局的状态与本 Agent 持有的凭证。
   */
  open(params: {
    readonly seed: number;
  }): Promise<{ readonly state: GameState; readonly token: string }>;

  /**
   * 从已有凭证恢复一局（用于续跑）。
   *
   * 语义：**不得产生新的副作用** —— 只是把上次的对局接回来。
   * 不可恢复时返回 null（调用方应重建对局并重放动作）。
   */
  resume?(params: { readonly token: string }): Promise<{ readonly state: GameState } | null>;

  /**
   * 观察当前局面。
   */
  observe(params: { readonly state: GameState; readonly token: string }): Promise<Observation>;

  /**
   * 执行一个动作。
   *
   * @returns 执行后的观察；失败时返回错误信息。
   */
  act(params: {
    readonly state: GameState;
    readonly token: string;
    readonly action: Action;
  }): Promise<{
    readonly ok: boolean;
    readonly observation?: Observation;
    readonly error?: string;
  }>;

  /**
   * 是否已终局。
   */
  isTerminal(params: { readonly state: GameState }): boolean;
}
