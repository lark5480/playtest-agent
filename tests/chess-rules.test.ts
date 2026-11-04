import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyMove,
  generateLegalMoves,
  isCheckmate,
  isStalemate,
  moveId,
  parseFen,
  positionToFen,
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
