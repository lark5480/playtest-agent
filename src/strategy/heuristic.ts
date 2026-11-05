/**
 * 确定性基线策略（地基冻结契约 ⑤）
 *
 * 用途有二：
 * 1. **降级路径** —— 模型不可用时，Agent 仍能跑完整局（承诺 C4）；
 * 2. **探索基线** —— 随机走子比"只走最优解"更容易撞出边界缺陷。
 *
 * 确定性保证：只用 seed + 局面，不用真随机、不用时间。
 */

import { createPrng, pickOne, seedFrom } from "../core/prng.js";
import type { Decision, Observation } from "../types/game.js";

import type { Strategy } from "./strategy.js";

export class HeuristicStrategy implements Strategy {
  readonly name = "heuristic-random";

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

    // **无状态**：每步只由 (seed, observation.seq) 派生 PRNG。
    //
    // 有状态 PRNG 的序列依赖"从第 0 步一路走到这里"；新进程续跑时内部状态已丢，
    // 从中间局面重新决策会得到不同动作，与"同 seed + 同局面 → 同动作"冲突。
    // 按显式输入派生后，续跑与独立运行能走出同一动作序列。
    const prng = createPrng(seedFrom(`${seed}:${observation.seq}`));
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
