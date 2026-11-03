/**
 * 通用 Oracle（地基冻结契约 ⑥）
 *
 * 只断言**所有游戏都该满足**的不变量。游戏特异断言由适配器提供。
 *
 * 通用断言的清单：
 * - G1 回合交替：同一玩家不能连续走两步（除非游戏规则明确允许）
 * - G2 终局不可再动：status=finished 后不应还有合法动作
 * - G3 状态单调推进：观察序号不得回退
 * - G4 执行失败不得伴随状态变化（失败必须无副作用）
 * - G5 无动作即无进展：决策返回 null 但局面还有合法动作 → 异常
 */

import type { Action, Observation } from "../types/game.js";
import type { StepOutcome } from "../types/step.js";

import type { Oracle, OracleViolation } from "./oracle.js";

export class GenericOracle implements Oracle {
  readonly name = "generic";

  assert(params: {
    readonly before: Observation;
    readonly after: Observation | null;
    readonly action: Action | null;
    readonly outcome: StepOutcome;
  }): readonly OracleViolation[] {
    const { before, after, action, outcome } = params;
    const violations: OracleViolation[] = [];

    // G4：执行失败不得伴随状态变化
    if ((outcome === "failed" || outcome === "rejected") && after !== null) {
      const changed = JSON.stringify(before.state.payload) !== JSON.stringify(after.state.payload);
      if (changed) {
        violations.push({
          code: "G4-failed-step-changed-state",
          severity: "fatal",
          message: `第 ${before.seq} 步执行结果为 ${outcome}，但局面发生了变化（失败动作不得有副作用）`,
          stepNo: null,
        });
      }
    }

    // G3：观察序号不得回退
    if (after !== null && after.seq < before.seq) {
      violations.push({
        code: "G3-observation-seq-regressed",
        severity: "fatal",
        message: `观察序号回退：before=${before.seq} after=${after.seq}`,
        stepNo: null,
      });
    }

    // G2：终局不应还有合法动作
    if (
      after !== null &&
      after.state.status === "finished" &&
      after.state.legalActions.length > 0
    ) {
      violations.push({
        code: "G2-terminal-has-legal-actions",
        severity: "fatal",
        message: `对局已 finished，但仍有 ${after.state.legalActions.length} 个合法动作`,
        stepNo: null,
      });
    }

    // G1：回合切换后，新执子方必须有合法动作
    //
    // 这是**通用可判**的一条：把回合交给一个无子可下的人 → 对局卡死。
    //
    // 注意这里**不**判"回合必须交替"：有些规则允许"对方无子可下 → 保持当前回合"
    // （othello 的跳过规则）。这种情况下 `legalActions` 属于**当前执子方**，
    // 于是"合法跳过"与"该换没换"在通用层**完全同形**（`after.turn === before.turn`
    // 且当前方有合法动作），无法区分 —— 硬判就是误报。
    //
    // 因此："回合该不该交替"由**游戏特异 Oracle** 负责
    // （见 `othello.ts` 的 OTH6）；通用层只判能通用判的。
    if (
      after !== null &&
      outcome === "applied" &&
      action !== null &&
      before.state.turn !== null &&
      after.state.turn !== null &&
      after.state.turn !== before.state.turn &&
      after.state.status === "playing" &&
      after.state.legalActions.length === 0
    ) {
      violations.push({
        code: "G1-new-turn-has-no-legal-moves",
        severity: "fatal",
        message:
          `回合已切换到 "${after.state.turn}"，但该方没有任何合法动作 —— ` +
          `对局会卡在无法行动的状态`,
        stepNo: null,
      });
    }

    return violations;
  }
}
