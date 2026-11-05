/**
 * 单测 · othello 游戏特异 Oracle（OTH1–OTH10）
 *
 * 用独立构造的棋盘验证新增断言：投影逐格比较、合法集、winner、累计棋子数。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { OthelloOracle } from "../src/oracle/othello.js";
import type { GameState, Observation } from "../src/types/game.js";

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

function initialBoard(): number[][] {
  const board = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => EMPTY));
  board[3]![3] = WHITE;
  board[3]![4] = BLACK;
  board[4]![3] = BLACK;
  board[4]![4] = WHITE;
  return board;
}

function flipsFor(
  board: number[][],
  row: number,
  col: number,
  player: number,
): Array<[number, number]> {
  if (board[row]?.[col] !== EMPTY) return [];
  const opp = player === BLACK ? WHITE : BLACK;
  const flips: Array<[number, number]> = [];
  for (const [dr, dc] of DIRECTIONS) {
    const line: Array<[number, number]> = [];
    let r = row + dr;
    let c = col + dc;
    while (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r]?.[c] === opp) {
      line.push([r, c]);
      r += dr;
      c += dc;
    }
    if (line.length > 0 && r >= 0 && r < 8 && c >= 0 && c < 8 && board[r]?.[c] === player) {
      flips.push(...line);
    }
  }
  return flips;
}

function legalIds(board: number[][], player: number): string[] {
  const ids: string[] = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      if (flipsFor(board, row, col, player).length > 0) ids.push(`${row},${col}`);
    }
  }
  return ids.sort();
}

function observation(board: number[][], over: Partial<GameState> = {}, seq = 0): Observation {
  return {
    state: {
      id: "room1",
      status: "playing",
      turn: "black",
      legalActions: legalIds(board, BLACK).map((id) => ({ id, payload: {} })),
      payload: { board, moveCount: 0, winner: null, seq: 0 },
      ...over,
    },
    seq,
    at: 1,
  };
}

function afterValidMove(): {
  before: Observation;
  after: Observation;
  action: { id: string; payload: Record<string, unknown> };
} {
  const beforeBoard = initialBoard();
  const afterBoard = beforeBoard.map((line) => [...line]);
  afterBoard[2]![3] = BLACK;
  for (const [r, c] of flipsFor(beforeBoard, 2, 3, BLACK)) afterBoard[r]![c] = BLACK;

  const before = observation(beforeBoard);
  const after = observation(
    afterBoard,
    {
      turn: "white",
      legalActions: legalIds(afterBoard, WHITE).map((id) => ({ id, payload: {} })),
      payload: { board: afterBoard, moveCount: 1, winner: null, seq: 1 },
    },
    1,
  );
  return { before, after, action: { id: "2,3", payload: { row: 2, col: 3 } } };
}

const oracle = new OthelloOracle();

test("合法一步：OTH2/OTH8/OTH10 均不误报", () => {
  const { before, after, action } = afterValidMove();
  assert.deepEqual(oracle.assert({ before, after, action, outcome: "applied" }), []);
});

test("OTH2：翻转位置不对 → 逐格投影不一致", () => {
  const { before, after, action } = afterValidMove();
  const board = (after.state.payload["board"] as number[][]).map((line) => [...line]);
  board[3]![3] = WHITE; // 本该翻转成黑，故意还原
  const bad = {
    ...after,
    state: {
      ...after.state,
      payload: { ...after.state.payload, board },
    },
  };
  const violations = oracle.assert({ before, after: bad, action, outcome: "applied" });
  assert.ok(violations.some((violation) => violation.code === "OTH2-board-projection-mismatch"));
});

test("OTH8：服务端合法集与本地计算不一致 → fatal", () => {
  const { before, after, action } = afterValidMove();
  const bad = { ...after, state: { ...after.state, legalActions: [] } };
  const violations = oracle.assert({ before, after: bad, action, outcome: "applied" });
  assert.ok(violations.some((violation) => violation.code === "OTH8-legal-actions-mismatch"));
});

test("OTH9：终局 winner 与棋子数不一致 → fatal", () => {
  const { before, action } = afterValidMove();
  const board = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => EMPTY));
  // 5 黑 2 白，moveCount=3（7 = 4 + 3）
  for (let i = 0; i < 5; i++) board[0]![i] = BLACK;
  board[0]![5] = WHITE;
  board[0]![6] = WHITE;
  const finished = observation(
    board,
    {
      status: "finished",
      turn: null,
      legalActions: [],
      payload: { board, moveCount: 3, winner: "white", seq: 3 },
    },
    4,
  );
  const violations = oracle.assert({ before, after: finished, action, outcome: "applied" });
  assert.ok(violations.some((violation) => violation.code === "OTH9-winner-mismatch"));
});

test("OTH10：棋子总数 ≠ 4 + moveCount → fatal", () => {
  const { before, action } = afterValidMove();
  const board = (before.state.payload["board"] as number[][]).map((line) => [...line]);
  board[2]![3] = BLACK; // 5 枚
  const bad = observation(
    board,
    {
      turn: "white",
      legalActions: legalIds(board, WHITE).map((id) => ({ id, payload: {} })),
      payload: { board, moveCount: 2, winner: null, seq: 2 },
    },
    2,
  );
  const violations = oracle.assert({ before, after: bad, action, outcome: "applied" });
  assert.ok(violations.some((violation) => violation.code === "OTH10-stone-count-mismatch"));
});
