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
 * - OTH2 落子后的整盘必须与本地投影逐格一致（翻转数量/位置）
 * - OTH3 落子后落点必须是己方棋子
 * - OTH4 棋子总数必须守恒（落子 +1， flips 枚数翻转，总数不变）
 * - OTH5 走子记录长度必须与 moveCount 一致
 * - OTH6 跳过规则
 * - OTH7 换人后新执子方必须有合法着
 * - OTH8 服务端给出的合法动作集必须与本地计算一致
 * - OTH9 终局 winner 必须与棋子数一致
 * - OTH10 棋子总数必须等于 4 + moveCount（累计口径）
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

/** 计算在 (row,col) 落 player 会翻转的棋子坐标（独立实现）。 */
function flipsFor(
  grid: number[][],
  row: number,
  col: number,
  player: number,
): Array<[number, number]> {
  if (grid[row]?.[col] !== EMPTY) return [];
  const opp = player === BLACK ? WHITE : BLACK;
  const flips: Array<[number, number]> = [];
  for (const [dr, dc] of DIRECTIONS) {
    const line: Array<[number, number]> = [];
    let r = row + dr;
    let c = col + dc;
    while (r >= 0 && r < 8 && c >= 0 && c < 8 && grid[r]?.[c] === opp) {
      line.push([r, c]);
      r += dr;
      c += dc;
    }
    if (line.length > 0 && r >= 0 && r < 8 && c >= 0 && c < 8 && grid[r]?.[c] === player) {
      flips.push(...line);
    }
  }
  return flips;
}

/** 计算在 (row,col) 落 player 会翻转的棋子数（独立实现）。 */
function flipCount(grid: number[][], row: number, col: number, player: number): number {
  return flipsFor(grid, row, col, player).length;
}

/** 本地投影：落子 + 翻转，返回新棋盘（不修改入参）。 */
function projectBoard(grid: number[][], row: number, col: number, player: number): number[][] {
  const next = grid.map((line) => [...line]);
  next[row]![col] = player;
  for (const [r, c] of flipsFor(grid, row, col, player)) {
    next[r]![c] = player;
  }
  return next;
}

/** 本地计算某方的全部合法动作 id（格式与适配器一致：`row,col`）。 */
function legalActionIds(grid: number[][], player: number): string[] {
  const ids: string[] = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      if (flipCount(grid, row, col, player) > 0) ids.push(`${row},${col}`);
    }
  }
  return ids.sort();
}

function countColor(grid: number[][], color: number): number {
  let n = 0;
  for (const row of grid) {
    for (const cell of row) {
      if (cell === color) n += 1;
    }
  }
  return n;
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

    // OTH2：落子后的整盘必须与本地投影逐格一致
    //
    // 这是比"翻转数量"更强的断言：不仅数量对，翻转位置也必须对。
    // 本地投影独立重写规则，不复用游戏的 gameLogic。
    const expectedBoard = projectBoard(beforeBoard.grid, row, col, turn);
    const mismatched: string[] = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (expectedBoard[r]?.[c] !== afterBoard.grid[r]?.[c]) mismatched.push(`(${r},${c})`);
      }
    }
    if (mismatched.length > 0) {
      violations.push({
        code: "OTH2-board-projection-mismatch",
        severity: "fatal",
        message:
          `落子后棋盘与本地投影不一致：${mismatched.length} 格不同，` +
          `例如 ${mismatched.slice(0, 5).join(" ")}`,
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

    // OTH8：服务端给出的合法动作集必须与本地独立计算一致
    if (after.state.turn !== null) {
      const nextPlayer = after.state.turn === "black" ? BLACK : WHITE;
      const expectedActions = legalActionIds(afterBoard.grid, nextPlayer);
      const actualActions = after.state.legalActions.map((candidate) => candidate.id).sort();
      if (
        expectedActions.length !== actualActions.length ||
        expectedActions.some((id, index) => id !== actualActions[index])
      ) {
        violations.push({
          code: "OTH8-legal-actions-mismatch",
          severity: "fatal",
          message:
            `合法动作集与本地计算不一致：期望 ${expectedActions.length} 个` +
            `[${expectedActions.slice(0, 6).join(" ")}]，` +
            `实际 ${actualActions.length} 个[${actualActions.slice(0, 6).join(" ")}]`,
          stepNo: null,
        });
      }
    }

    // OTH9：终局 winner 必须与棋子数一致
    if (after.state.status === "finished") {
      const blackStones = countColor(afterBoard.grid, BLACK);
      const whiteStones = countColor(afterBoard.grid, WHITE);
      const expectedWinner =
        blackStones > whiteStones ? "black" : whiteStones > blackStones ? "white" : "draw";
      const actualWinner = after.state.payload["winner"];
      if (actualWinner !== expectedWinner) {
        violations.push({
          code: "OTH9-winner-mismatch",
          severity: "fatal",
          message:
            `终局 winner 与棋子数不一致：黑 ${blackStones} / 白 ${whiteStones} ` +
            `→ 应为 "${expectedWinner}"，实际 "${String(actualWinner)}"`,
          stepNo: null,
        });
      }
    }

    // OTH10：棋子总数 === 4 + moveCount（累计口径）
    const moveCountRaw = after.state.payload["moveCount"];
    if (typeof moveCountRaw === "number") {
      const stones = countStones(afterBoard.grid);
      if (stones !== 4 + moveCountRaw) {
        violations.push({
          code: "OTH10-stone-count-mismatch",
          severity: "fatal",
          message: `棋子总数 ${stones} ≠ 4 + moveCount(${moveCountRaw}) = ${4 + moveCountRaw}`,
          stepNo: null,
        });
      }
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
