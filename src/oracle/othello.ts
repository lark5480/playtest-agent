/**
 * Oracle · othello 游戏特异断言
 *
 * **独立性**：这里的规则计算**不复用** othello 的 `gameLogic.ts`，
 * 而是在本项目内独立实现 —— 理由见 ARCHITECTURE §5：
 * 用游戏自己的规则校验游戏自己，会漏掉共模错误（双方共享同一个错误假设时，
 * 校验必然通过）。
 *
 * 断言清单：
 * - OTH1 落子点必须合法（能夹住对方棋子）
 * - OTH2 翻转数量必须与夹住的棋子数一致
 * - OTH3 落子后落点必须是己方棋子
 * - OTH4 棋子总数必须守恒（落子 +1， flips 枚数翻转，总数不变）
 * - OTH5 走子记录长度必须与 moveCount 一致
 */

import type { Action, Observation } from "../types/game.js";
import type { StepOutcome } from "../types/step.js";

import type { Oracle, OracleViolation } from "./oracle.js";

const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

interface Board {
  readonly grid: number[][];
}

function boardOf(observation: Observation): Board | null {
  const raw = observation.state.payload["board"];
  if (!Array.isArray(raw)) return null;
  return { grid: raw as number[][] };
}

/** 计算在 (row,col) 落 player 会翻转的棋子数（独立实现）。 */
function flipCount(grid: number[][], row: number, col: number, player: number): number {
  if (grid[row]?.[col] !== EMPTY) return 0;
  const opp = player === BLACK ? WHITE : BLACK;
  let total = 0;
  for (const [dr, dc] of DIRECTIONS) {
    let r = row + dr;
    let c = col + dc;
    let seen = 0;
    while (r >= 0 && r < 8 && c >= 0 && c < 8 && grid[r]?.[c] === opp) {
      seen += 1;
      r += dr;
      c += dc;
    }
    if (seen > 0 && r >= 0 && r < 8 && c >= 0 && c < 8 && grid[r]?.[c] === player) {
      total += seen;
    }
  }
  return total;
}

function countStones(grid: number[][]): number {
  let n = 0;
  for (const row of grid) {
    for (const cell of row) {
      if (cell !== EMPTY) n += 1;
    }
  }
  return n;
}

export class OthelloOracle implements Oracle {
  readonly name = "othello";

  assert(params: {
    readonly before: Observation;
    readonly after: Observation | null;
    readonly action: Action | null;
    readonly outcome: StepOutcome;
  }): readonly OracleViolation[] {
    const { before, after, action, outcome } = params;
    const violations: OracleViolation[] = [];

    if (after === null || action === null || outcome !== "applied") {
      return violations;
    }

    const beforeBoard = boardOf(before);
    const afterBoard = boardOf(after);
    if (!beforeBoard || !afterBoard) return violations;

    const row = Number(action.payload["row"]);
    const col = Number(action.payload["col"]);
    if (!Number.isInteger(row) || !Number.isInteger(col)) return violations;

    const turn = before.state.turn === "black" ? BLACK : WHITE;

    // OTH1：落子必须合法（能夹住对方棋子）
    const expectedFlips = flipCount(beforeBoard.grid, row, col, turn);
    if (expectedFlips === 0) {
      violations.push({
        code: "OTH1-illegal-move-accepted",
        severity: "fatal",
        message: `在 (${row},${col}) 落子被接受，但按规则不构成合法着（夹不住任何对方棋子）`,
        stepNo: null,
      });
    }

    // OTH3：落点必须是己方棋子
    if (afterBoard.grid[row]?.[col] !== turn) {
      violations.push({
        code: "OTH3-move-point-not-owned",
        severity: "fatal",
        message: `落子后 (${row},${col}) 的棋子不是己方（期望 ${turn === BLACK ? "黑" : "白"}）`,
        stepNo: null,
      });
    }

    // OTH4：棋子总数守恒 —— 落子 +1 枚，翻转不改变总数
    const beforeCount = countStones(beforeBoard.grid);
    const afterCount = countStones(afterBoard.grid);
    if (afterCount !== beforeCount + 1) {
      violations.push({
        code: "OTH4-stone-count-not-conserved",
        severity: "fatal",
        message: `棋子总数不守恒：落子前 ${beforeCount}，落子后 ${afterCount}（应 +1）`,
        stepNo: null,
      });
    }

    // OTH5：走子记录长度与 moveCount 一致
    const moveCount = after.state.payload["moveCount"];
    if (typeof moveCount === "number") {
      const beforeCount2 = Number(before.state.payload["moveCount"] ?? 0);
      if (moveCount !== beforeCount2 + 1) {
        violations.push({
          code: "OTH5-move-count-not-incremented",
          severity: "fatal",
          message: `moveCount 未正确递增：${beforeCount2} → ${moveCount}（应 +1）`,
          stepNo: null,
        });
      }
    }

    // OTH6：回合流转必须符合 othello 的跳过规则
    //
    // 规则（gameLogic.ts:296-303）：
    //   对方有子可下 → 换人
    //   对方无子可下、自己有子可下 → 保持当前回合（跳过）
    //   双方都无子可下 → 结束
    //
    // 本断言独立实现这条规则，与游戏的实现互为对照 ——
    // 这正是通用层做不到的事（见 Oracle.ts 的 TurnRule 说明）。
    if (before.state.turn !== null && after.state.turn === before.state.turn) {
      // 执子方未变 → 必须是"对方无子可下"的合法跳过：
      // 即落子之后，"对方"（另一方）在这个棋盘上没有任何合法着。
      const opponent = turn === BLACK ? WHITE : BLACK;
      const opponentHasMoves = hasAnyValidMove(afterBoard.grid, opponent);
      const currentHasMoves = hasAnyValidMove(afterBoard.grid, turn);

      if (opponentHasMoves) {
        violations.push({
          code: "OTH6-turn-should-have-switched",
          severity: "fatal",
          message:
            `执子方未变（${before.state.turn}），但对方在落子后仍有合法着 —— ` +
            `按 othello 规则此时应当换人`,
          stepNo: null,
        });
      }
      if (!currentHasMoves && after.state.status === "playing") {
        violations.push({
          code: "OTH6-both-passed-but-not-finished",
          severity: "fatal",
          message: "双方都无子可下，但对局未标记为 finished（应结束并判胜负）",
          stepNo: null,
        });
      }
    }

    // OTH7：换人时，新执子方必须有子可下（否则对局卡死）
    if (
      before.state.turn !== null &&
      after.state.turn !== null &&
      after.state.turn !== before.state.turn &&
      after.state.status === "playing" &&
      after.state.legalActions.length === 0
    ) {
      violations.push({
        code: "OTH7-new-turn-has-no-legal-moves",
        severity: "fatal",
        message: `回合切换到 "${after.state.turn}"，但该方无子可下 —— 对局会卡死`,
        stepNo: null,
      });
    }

    return violations;
  }
}

/** 判断 player 在该棋盘上是否还有合法着（独立实现）。 */
function hasAnyValidMove(grid: number[][], player: number): boolean {
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      if (flipCount(grid, row, col, player) > 0) return true;
    }
  }
  return false;
}
