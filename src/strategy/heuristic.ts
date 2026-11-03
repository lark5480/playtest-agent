/**
 * 确定性基线策略（地基冻结契约 ⑤）
 *
 * 用途有二：
 * 1. **降级路径** —— 模型不可用时，Agent 仍能跑完整局（承诺 C4）；
 * 2. **探索基线** —— 随机走子比"只走最优解"更容易撞出边界缺陷。
 *
 * 确定性保证：只用 seed + 局面，不用真随机、不用时间。
 */

import { createPrng, pickOne } from "../core/prng.js";
import type { Prng } from "../core/prng.js";
import type { Decision, Observation } from "../types/game.js";

import type { Strategy } from "./strategy.js";

export class HeuristicStrategy implements Strategy {
  readonly name = "heuristic-random";

  /**
   * 每个 seed 一个 PRNG 实例。
   *
   * PRNG 是有状态的：连续调用会漂移。若每次 decide 都新建，
   * 每步都会取到序列的第一个数 → 动作只由"合法动作集的顺序"决定，
   * 探索性为零（总选第一个合法点）。
   *
   * 按 seed 缓存实例 → 同 seed 的整局动作序列完全确定（红线 2.4）。
   */
  private readonly prngs = new Map<number, Prng>();

  async decide(params: {
    readonly observation: Observation;
    readonly seed: number;
  }): Promise<Decision> {
    const { observation, seed } = params;
    const actions = observation.state.legalActions;

    if (actions.length === 0) {
      return {
        action: null,
        reason: "无合法动作",
        degraded: false,
      };
    }

    let prng = this.prngs.get(seed);
    if (!prng) {
      prng = createPrng(seed);
      this.prngs.set(seed, prng);
    }

    const chosen = pickOne(prng, actions);
    if (!chosen) {
      return { action: null, reason: "合法动作集为空", degraded: false };
    }

    return {
      action: chosen,
      reason: `随机选取 ${chosen.id}（共 ${actions.length} 个合法动作）`,
      degraded: false,
    };
  }
}
