/**
 * Oracle SPI（地基冻结契约 ⑥）
 *
 * Oracle 是"断言层"：在每一步执行后检查游戏状态是否自洽。
 *
 * 分层：
 * - **通用断言**：所有游戏都该满足（回合交替、状态单调推进、终局不可再动）。
 * - **游戏特异断言**：合法动作集正确、状态迁移合法等（由适配器提供）。
 *
 * Oracle 跑在**被测游戏之外** —— 它是独立实现，不复用被测游戏的规则代码，
 * 否则"用游戏自己的规则校验游戏自己"会漏掉共模错误。
 */

import type { Action, Observation } from "../types/game.js";
import type { StepOutcome } from "../types/step.js";

/**
 * 断言失败项。
 */
export interface OracleViolation {
  /** 稳定的缺陷编号（跨次运行可对照）。 */
  readonly code: string;
  /** 严重级别：fatal = 场景判失败；warning = 记录但不中断。 */
  readonly severity: "fatal" | "warning";
  /** 描述。 */
  readonly message: string;
  /** 关联的步骤序号；无关联时为 null。 */
  readonly stepNo: number | null;
}

/**
 * Oracle。
 */
export interface Oracle {
  /** 断言集标识（写进报告）。 */
  readonly name: string;

  /**
   * 校验一步执行。
   *
   * @param before 执行前观察
   * @param after 执行后观察（执行失败时为 null）
   * @param action 本步动作
   * @param outcome 执行结果
   */
  assert(params: {
    readonly before: Observation;
    readonly after: Observation | null;
    readonly action: Action | null;
    readonly outcome: StepOutcome;
  }): readonly OracleViolation[];
}

/**
 * 回合规则的声明。
 *
 * 通用层**无法**区分"合法跳过"与"该换没换"—— 因为 `legalActions` 永远属于
 * 当前执子方，两种情况下 `after.turn === before.turn` 且当前方有合法动作，
 * 形状完全相同。
 *
 * 因此回合规则必须由**游戏特异**的断言集声明，而不能由通用层猜测。
 */
export type TurnRule =
  /** 回合必须严格交替（棋类对战等）。 */
  | "strict-alternate"
  /** 允许"对方无子可下 → 保持当前回合"的跳过（othello 等）。 */
  | "allow-pass"
  /** 不关心回合（回合由游戏特异断言自行判定）。 */
  | "unspecified";
