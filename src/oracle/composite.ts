/**
 * Oracle · 组合器
 *
 * 把多个断言集合成一个。通用断言 + 游戏特异断言一起跑。
 *
 * 语义：**任一断言集报 fatal 即整轮判失败**；warning 合并记录。
 */

import type { Action, Observation } from "../types/game.js";
import type { StepOutcome } from "../types/step.js";

import type { Oracle, OracleViolation } from "./oracle.js";

export class CompositeOracle implements Oracle {
  readonly name: string;

  private readonly oracles: readonly Oracle[];

  public constructor(oracles: readonly Oracle[]) {
    this.oracles = oracles;
    this.name = oracles.map((o) => o.name).join("+") || "empty";
  }

  assert(params: {
    readonly before: Observation;
    readonly after: Observation | null;
    readonly action: Action | null;
    readonly outcome: StepOutcome;
  }): readonly OracleViolation[] {
    const violations: OracleViolation[] = [];
    for (const oracle of this.oracles) {
      violations.push(...oracle.assert(params));
    }
    return violations;
  }
}
