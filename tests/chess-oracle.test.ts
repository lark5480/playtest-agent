import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyMove,
  generateLegalMoves,
  moveId,
  positionToFen,
  startPosition,
} from "../src/core/chess-rules.js";
import type { ChessPosition } from "../src/core/chess-rules.js";
import { ChessOracle } from "../src/oracle/chess.js";
import type { Action, GameState, Observation } from "../src/types/game.js";

function play(position: ChessPosition, ids: readonly string[]): ChessPosition {
  let current = position;
  for (const id of ids) {
    const move = generateLegalMoves(current).find((candidate) => moveId(candidate) === id);
    assert.ok(move, `找不到合法着 ${id}`);
    current = applyMove(current, move);
  }
  return current;
}

function observation(
  position: ChessPosition,
  params: {
    readonly status?: GameState["status"];
    readonly moves?: readonly string[];
    readonly result?: Record<string, unknown> | null;
    readonly legalActions?: readonly Action[];
  } = {},
): Observation {
  const status = params.status ?? "playing";
  return {
    state: {
      id: "R00001",
      status,
      turn: status === "finished" ? null : position.turn === "w" ? "white" : "black",
      legalActions: params.legalActions ?? [{ id: "dummy", payload: { from: "a1", to: "a2" } }],
      payload: {
        fen: positionToFen(position),
        moveCount: (params.moves ?? []).length,
        moves: [...(params.moves ?? [])],
        result: params.result ?? null,
      },
    },
    seq: 0,
    at: 0,
  };
}

function assertMove(action: string, from: string, to: string, promotion?: string): Action {
  return {
    id: action,
    payload: { from, to, ...(promotion ? { promotion } : {}) },
  };
}

test("合法走子不产生断言", () => {
  const before = observation(startPosition());
  const after = observation(play(startPosition(), ["e2e4"]), { moves: ["e2e4"] });
  const violations = new ChessOracle().assert({
    before,
    after,
    action: assertMove("e2e4", "e2", "e4"),
    outcome: "applied",
  });
  assert.deepEqual(violations, []);
});

test("服务端接受非法走子 → CHS1", () => {
  const before = observation(startPosition());
  const after = observation(play(startPosition(), ["e2e4"]), { moves: ["e2e4"] });
  const violations = new ChessOracle().assert({
    before,
    after,
    action: assertMove("e2e5", "e2", "e5"),
    outcome: "applied",
  });
  assert.ok(violations.some((v) => v.code === "CHS1-illegal-move-accepted"));
});

test("走子后的 FEN 与独立推演不符 → CHS2", () => {
  const before = observation(startPosition());
  const after = observation(startPosition(), { moves: ["e2e4"], status: "playing" });
  const violations = new ChessOracle().assert({
    before,
    after,
    action: assertMove("e2e4", "e2", "e4"),
    outcome: "applied",
  });
  assert.ok(violations.some((v) => v.code === "CHS2-fen-mismatch"));
});

test("将死结果胜方错误 → CHS5", () => {
  const beforePos = play(startPosition(), ["f2f3", "e7e5", "g2g4"]);
  const afterPos = play(beforePos, ["d8h4"]);
  const before = observation(beforePos, { moves: ["f2f3", "e7e5", "g2g4"] });
  const after = observation(afterPos, {
    status: "finished",
    moves: ["f2f3", "e7e5", "g2g4", "d8h4"],
    legalActions: [],
    result: { winner: "white", reason: "checkmate" },
  });
  const violations = new ChessOracle().assert({
    before,
    after,
    action: assertMove("d8h4", "d8", "h4"),
    outcome: "applied",
  });
  assert.ok(violations.some((v) => v.code === "CHS5-checkmate-winner-wrong"));
});

test("将死结果正确时不产生断言", () => {
  const beforePos = play(startPosition(), ["f2f3", "e7e5", "g2g4"]);
  const afterPos = play(beforePos, ["d8h4"]);
  const before = observation(beforePos, { moves: ["f2f3", "e7e5", "g2g4"] });
  const after = observation(afterPos, {
    status: "finished",
    moves: ["f2f3", "e7e5", "g2g4", "d8h4"],
    legalActions: [],
    result: { winner: "black", reason: "checkmate" },
  });
  const violations = new ChessOracle().assert({
    before,
    after,
    action: assertMove("d8h4", "d8", "h4"),
    outcome: "applied",
  });
  assert.deepEqual(violations, []);
});
