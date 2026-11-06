/**
 * 策略 SPI（地基冻结契约 ⑤）
 *
 * 策略只回答"在这个局面下选哪个动作"，不负责执行。
 *
 * 基线策略由 seed、观察序号与显式上下文确定；模型采样不承诺重采样一致。
 * 模型路径的复现依赖完整录制动作，不重新询问模型。
 */

import type { Decision, ExplorationContext, Observation } from "../types/game.js";

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
  decide(params: {
    readonly observation: Observation;
    readonly seed: number;
    readonly exploration?: ExplorationContext;
  }): Promise<Decision>;
}
