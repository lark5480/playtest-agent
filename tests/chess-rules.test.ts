import assert from "node:assert/strict";
import { test } from "node:test";

import {
  analyzeHistory,
  applyMove,
  generateLegalMoves,
  isCheckmate,
  isStalemate,
  moveId,
  parseFen,
  positionToFen,
  repetitionKey,
  squareIndex,
  startPosition,
} from "../src/core/chess-rules.js";
import type { ChessPosition } from "../src/core/chess-rules.js";

function play(fen: string, ids: readonly string[]): ChessPosition {
  let position = parseFen(fen);
  for (const id of ids) {
    const move = generateLegalMoves(position).find((candidate) => moveId(candidate) === id);
    assert.ok(move, `局面中找不到合法着 ${id}`);
    position = applyMove(position, move);
  }
  return position;
}

/** 走一串着法，返回每一步之后的 FEN 历史（第 0 项是起始局面）。 */
function playHistory(fen: string, ids: readonly string[]): string[] {
  let position = parseFen(fen);
  const history = [positionToFen(position)];
  for (const id of ids) {
    const move = generateLegalMoves(position).find((candidate) => moveId(candidate) === id);
    assert.ok(move, `局面中找不到合法着 ${id}`);
    position = applyMove(position, move);
    history.push(positionToFen(position));
  }
  return history;
}

test("初始局面有 20 个合法着", () => {
  assert.equal(generateLegalMoves(startPosition()).length, 20);
});

test("FEN 解析与序列化可往返", () => {
  const fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
  assert.equal(positionToFen(parseFen(fen)), fen);
});

test("e2e4 后 FEN 正确（无邻格敌兵时不保留吃过路兵目标）", () => {
  const after = play(positionToFen(startPosition()), ["e2e4"]);
  assert.equal(positionToFen(after), "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
});

test("愚人杀最终被判定为将死", () => {
  const after = play(positionToFen(startPosition()), ["f2f3", "e7e5", "g2g4", "d8h4"]);
  assert.equal(generateLegalMoves(after).length, 0);
  assert.equal(isCheckmate(after), true);
});

test("王车易位：短易位同时移动王与车", () => {
  const fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
  const legal = generateLegalMoves(parseFen(fen)).map(moveId);
  assert.ok(legal.includes("e1g1"), "应允许短易位");
  assert.ok(legal.includes("e1c1"), "应允许长易位");

  const after = play(fen, ["e1g1"]);
  assert.equal(positionToFen(after), "r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1");
});

test("吃过路兵会移除相邻斜后方的兵", () => {
  const fen = "rnbqkbnr/1pp1pppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3";
  const legal = generateLegalMoves(parseFen(fen)).map(moveId);
  assert.ok(legal.includes("e5d6"), "应识别吃过路兵");

  const after = play(fen, ["e5d6"]);
  assert.equal(after.board[squareIndex("d5")], null, "d5 上的黑兵应被移除");
  assert.equal(after.board[squareIndex("d6")]?.color, "w", "d6 应为白兵");
});

test("升变生成四种选择，且落到指定棋子", () => {
  const fen = "8/P7/8/8/8/8/4k3/7K w - - 0 1";
  const legal = generateLegalMoves(parseFen(fen)).map(moveId);
  for (const piece of ["q", "r", "b", "n"]) {
    assert.ok(legal.includes(`a7a8${piece}`), `应包含升变为 ${piece}`);
  }

  const after = play(fen, ["a7a8q"]);
  assert.equal(after.board[squareIndex("a8")]?.type, "q");
  assert.equal(after.board[squareIndex("a8")]?.color, "w");
});

test("被钉住的马不能离开遮挡线", () => {
  const fen = "k3r3/8/8/8/8/8/4N3/4K3 w - - 0 1";
  const legal = generateLegalMoves(parseFen(fen)).map(moveId);
  assert.equal(
    legal.filter((id) => id.startsWith("e2")).length,
    0,
    "e2 的马一动就会暴露王，不应出现在合法着里",
  );
});

test("无子可动且未被将军时判定为逼和", () => {
  const position = parseFen("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1");
  assert.equal(generateLegalMoves(position).length, 0);
  assert.equal(isStalemate(position), true);
});

// ---------------------------------------------------------------- 历史型终局

test("同一局面出现三次 → 三次重复和棋", () => {
  const history = playHistory(positionToFen(startPosition()), [
    "g1f3",
    "g8f6",
    "f3g1",
    "f6g8",
    "g1f3",
    "g8f6",
    "f3g1",
    "f6g8",
  ]);

  const state = analyzeHistory(history);
  assert.equal(state.repetitionCount, 3);
  assert.equal(state.threefold, true);
  assert.equal(state.reason, "threefold");
});

test("同一局面只出现两次 → 还不算三次重复", () => {
  const history = playHistory(positionToFen(startPosition()), ["g1f3", "g8f6", "f3g1", "f6g8"]);

  const state = analyzeHistory(history);
  assert.equal(state.repetitionCount, 2);
  assert.equal(state.threefold, false);
  assert.equal(state.reason, null);
});

test("棋盘看起来一样但易位权变了 → 不是重复局面", () => {
  // 白车 a1→a2→a1、黑车 a8→a7→a8：棋盘与第 4 步完全一致，
  // 但双方都失去了后翼易位权，FIDE 认为这不是同一局面。
  const history = playHistory(positionToFen(startPosition()), [
    "b1c3",
    "b8c6",
    "a2a3",
    "a7a5",
    "a1a2",
    "a8a7",
    "a2a1",
    "a7a8",
  ]);

  const state = analyzeHistory(history);
  assert.equal(state.repetitionCount, 1, "当前局面只出现过一次");
  assert.equal(state.threefold, false);

  // 直观看：第 4 步后的棋盘与末局面完全相同，只有易位权不同。
  const boardOnly = (fen: string) => fen.split(" ").slice(0, 2).join(" ");
  assert.equal(boardOnly(history[4]!), boardOnly(history[history.length - 1]!));
  assert.notEqual(repetitionKey(parseFen(history[4]!)), repetitionKey(parseFen(history.at(-1)!)));
});

test("吃过路兵权不同 → 重复键不同", () => {
  const withEp = parseFen("4k3/8/8/8/4pP2/8/8/4K3 b - f3 0 1");
  const withoutEp = parseFen("4k3/8/8/8/4pP2/8/8/4K3 b - - 0 1");
  assert.notEqual(repetitionKey(withEp), repetitionKey(withoutEp));
});

test("半回合到 99 不算 50 步，到 100 才判和棋", () => {
  const start = "8/8/8/8/8/8/5k2/7K w - - 98 1";

  const at99 = analyzeHistory(playHistory(start, ["h1h2"]));
  assert.equal(at99.halfmoveClock, 99);
  assert.equal(at99.fiftyMove, false);
  assert.equal(at99.reason, null);

  const at100 = analyzeHistory(playHistory(start, ["h1h2", "f2f3"]));
  assert.equal(at100.halfmoveClock, 100);
  assert.equal(at100.fiftyMove, true);
  assert.equal(at100.reason, "fifty");
});

test("兵动或吃子会把半回合计数清零", () => {
  const history = playHistory("8/8/8/8/8/8/5k2/7K w - - 99 1", ["h1h2"]);

  // 走兵：半回合从 0 起始，走完仍是 0 会被重置。
  const pawnHistory = playHistory("4k3/8/8/8/8/8/4P3/4K3 w - e3 0 1", ["e2e4"]);
  assert.equal(analyzeHistory(pawnHistory).halfmoveClock, 0);

  // 吃子：车吃掉 a2 的兵，半回合从 40 归零。
  const captureHistory = playHistory("4k3/8/8/8/8/8/p7/R3K3 w - - 40 1", ["a1a2"]);
  assert.equal(analyzeHistory(captureHistory).halfmoveClock, 0);

  // 非兵非吃子：半回合继续累加到 100。
  assert.equal(analyzeHistory(history).halfmoveClock, 100);
});
