/**
 * 策略 SPI（地基冻结契约 ⑤）
 *
 * 策略只回答"在这个局面下选哪个动作"，不负责执行。
 *
 * 关键设计：**策略必须确定性**。同 seed + 同局面 → 同动作。
 * 这条约束是"缺陷可复现"的地基 —— 若策略带真实随机或模型采样，
 * 同一个缺陷下次就复现不出来，报告也就失去证据价值。
 */

import type { Decision, Observation } from "../types/game.js";

/**
 * 策略。
 */
export interface Strategy {
  /** 策略标识（写进报告）。 */
  readonly name: string;

  /**
   * 决策。
   *
   * @param observation 当前局面
   * @param seed 本次运行的种子（确定性策略必须只依赖它 + 局面）
   */
  decide(params: { readonly observation: Observation; readonly seed: number }): Promise<Decision>;
}
