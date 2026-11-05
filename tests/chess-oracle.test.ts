import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyMove,
  generateLegalMoves,
  moveId,
  parseFen,
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
    readonly fenHistory?: readonly string[];
  } = {},
): Observation {
  const status = params.status ?? "playing";
  const defaultLegalActions =
    status === "finished"
      ? []
      : generateLegalMoves(position).map((move) => ({ id: moveId(move), payload: {} }));
  return {
    state: {
      id: "R00001",
      status,
      turn: status === "finished" ? null : position.turn === "w" ? "white" : "black",
      legalActions: params.legalActions ?? defaultLegalActions,
      payload: {
        fen: positionToFen(position),
        moveCount: (params.moves ?? []).length,
        moves: [...(params.moves ?? [])],
        ...(params.fenHistory ? { fenHistory: [...params.fenHistory] } : {}),
        result: params.result ?? null,
      },
    },
    seq: 0,
    at: 0,
  };
}

/** 走一串着法，返回每一步之后的 FEN 历史（第 0 项是起始局面）。 */
function playHistory(position: ChessPosition, ids: readonly string[]): string[] {
  let current = position;
  const history = [positionToFen(current)];
  for (const id of ids) {
    const move = generateLegalMoves(current).find((candidate) => moveId(candidate) === id);
    assert.ok(move, `找不到合法着 ${id}`);
    current = applyMove(current, move);
    history.push(positionToFen(current));
  }
  return history;
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

// ---------------------------------------------------------------- 历史型终局（CHS8–CHS11）

const SHUFFLE = ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"];

test("三次重复且服务端判 threefold → 无断言", () => {
  const beforePos = play(startPosition(), SHUFFLE.slice(0, 7));
  const afterPos = play(startPosition(), SHUFFLE);
  const history = playHistory(startPosition(), SHUFFLE);

  const violations = new ChessOracle().assert({
    before: observation(beforePos, { moves: SHUFFLE.slice(0, 7) }),
    after: observation(afterPos, {
      status: "finished",
      moves: SHUFFLE,
      legalActions: [],
      fenHistory: history,
      result: { winner: null, reason: "threefold" },
    }),
    action: assertMove("f6g8", "f6", "g8"),
    outcome: "applied",
  });
  assert.deepEqual(violations, []);
});

test("服务端判 threefold 但历史只重复两次 → CHS8", () => {
  const beforePos = play(startPosition(), SHUFFLE.slice(0, 3));
  const afterPos = play(startPosition(), SHUFFLE.slice(0, 4));
  const history = playHistory(startPosition(), SHUFFLE.slice(0, 4));

  const violations = new ChessOracle().assert({
    before: observation(beforePos, { moves: SHUFFLE.slice(0, 3) }),
    after: observation(afterPos, {
      status: "finished",
      moves: SHUFFLE.slice(0, 4),
      legalActions: [],
      fenHistory: history,
      result: { winner: null, reason: "threefold" },
    }),
    action: assertMove("f6g8", "f6", "g8"),
    outcome: "applied",
  });
  assert.ok(violations.some((v) => v.code === "CHS8-threefold-without-repetition"));
});

test("服务端判 fifty 但半回合不到 100 → CHS9", () => {
  const beforePos = startPosition();
  const afterPos = play(startPosition(), ["e2e4"]);

  const violations = new ChessOracle().assert({
    before: observation(beforePos),
    after: observation(afterPos, {
      status: "finished",
      moves: ["e2e4"],
      legalActions: [],
      fenHistory: [positionToFen(beforePos), positionToFen(afterPos)],
      result: { winner: null, reason: "fifty" },
    }),
    action: assertMove("e2e4", "e2", "e4"),
    outcome: "applied",
  });
  assert.ok(violations.some((v) => v.code === "CHS9-fifty-move-clock-below-100"));
});

test("本地历史已三次重复、服务端仍报 playing → CHS10", () => {
  const beforePos = play(startPosition(), SHUFFLE.slice(0, 7));
  const afterPos = play(startPosition(), SHUFFLE);
  const history = playHistory(startPosition(), SHUFFLE);

  const violations = new ChessOracle().assert({
    before: observation(beforePos, { moves: SHUFFLE.slice(0, 7) }),
    after: observation(afterPos, {
      status: "playing",
      moves: SHUFFLE,
      fenHistory: history,
    }),
    action: assertMove("f6g8", "f6", "g8"),
    outcome: "applied",
  });
  assert.ok(violations.some((v) => v.code === "CHS10-history-draw-missed"));
});

test("50 步达到 100 半回合并判 fifty → 无断言", () => {
  const beforePos = parseFen("8/8/8/8/8/8/5k2/7K w - - 99 1");
  const afterPos = play(beforePos, ["h1h2"]);

  const violations = new ChessOracle().assert({
    before: observation(beforePos),
    after: observation(afterPos, {
      status: "finished",
      moves: ["h1h2"],
      legalActions: [],
      fenHistory: [positionToFen(beforePos), positionToFen(afterPos)],
      result: { winner: null, reason: "fifty" },
    }),
    action: assertMove("h1h2", "h1", "h2"),
    outcome: "applied",
  });
  assert.deepEqual(violations, []);
});

test("棋盘实际是将死却判和 → CHS11", () => {
  const beforePos = play(startPosition(), ["f2f3", "e7e5", "g2g4"]);
  const afterPos = play(beforePos, ["d8h4"]);

  const violations = new ChessOracle().assert({
    before: observation(beforePos, { moves: ["f2f3", "e7e5", "g2g4"] }),
    after: observation(afterPos, {
      status: "finished",
      moves: ["f2f3", "e7e5", "g2g4", "d8h4"],
      legalActions: [],
      result: { winner: null, reason: "draw" },
    }),
    action: assertMove("d8h4", "d8", "h4"),
    outcome: "applied",
  });
  assert.ok(violations.some((v) => v.code === "CHS11-draw-vs-checkmate"));
});

test("合法集与本地不一致 → CHS12", () => {
  const before = observation(startPosition());
  const after = observation(play(startPosition(), ["e2e4"]), {
    moves: ["e2e4"],
    legalActions: [],
  });
  const violations = new ChessOracle().assert({
    before,
    after,
    action: assertMove("e2e4", "e2", "e4"),
    outcome: "applied",
  });
  assert.ok(violations.some((v) => v.code === "CHS12-legal-actions-mismatch"));
});

test("fenHistory 长度不对 → CHS13", () => {
  const start = startPosition();
  const history = playHistory(start, ["e2e4"]);
  const afterPos = play(start, ["e2e4"]);
  const violations = new ChessOracle().assert({
    before: observation(start),
    after: observation(afterPos, {
      moves: ["e2e4"],
      fenHistory: [history[0]!],
    }),
    action: assertMove("e2e4", "e2", "e4"),
    outcome: "applied",
  });
  assert.ok(violations.some((v) => v.code === "CHS13-fen-history-length-mismatch"));
});

test("fenHistory 末项与当前 FEN 不一致 → CHS13", () => {
  const start = startPosition();
  const history = playHistory(start, ["e2e4"]);
  const afterPos = play(start, ["e2e4"]);
  const violations = new ChessOracle().assert({
    before: observation(start),
    after: observation(afterPos, {
      moves: ["e2e4"],
      fenHistory: [history[0]!, history[0]!],
    }),
    action: assertMove("e2e4", "e2", "e4"),
    outcome: "applied",
  });
  assert.ok(violations.some((v) => v.code === "CHS13-fen-history-tail-mismatch"));
});

test("fenHistory 相邻两步无法一步到达 → CHS13", () => {
  const start = startPosition();
  const e4History = playHistory(start, ["e2e4"]);
  const d4History = playHistory(start, ["d2d4"]);
  const afterPos = play(start, ["e2e4"]);
  const violations = new ChessOracle().assert({
    before: observation(start),
    after: observation(afterPos, {
      moves: ["e2e4"],
      fenHistory: [d4History[1]!, e4History[1]!],
    }),
    action: assertMove("e2e4", "e2", "e4"),
    outcome: "applied",
  });
  assert.ok(violations.some((v) => v.code === "CHS13-fen-history-not-reachable"));
});

test("子力不足仍 playing → CHS14", () => {
  const beforePos = parseFen("8/8/8/8/8/8/8/K6k w - - 0 1");
  const move = generateLegalMoves(beforePos).find((candidate) => moveId(candidate) === "a1a2");
  assert.ok(move, "K vs K 局面应有 a1a2");
  const afterPos = applyMove(beforePos, move);

  const violations = new ChessOracle().assert({
    before: observation(beforePos),
    after: observation(afterPos, { moves: ["a1a2"] }),
    action: assertMove("a1a2", "a1", "a2"),
    outcome: "applied",
  });
  assert.ok(violations.some((v) => v.code === "CHS14-insufficient-material-not-drawn"));
});

test("playing 却带 result → CHS15", () => {
  const violations = new ChessOracle().assert({
    before: observation(startPosition()),
    after: observation(play(startPosition(), ["e2e4"]), {
      moves: ["e2e4"],
      result: { winner: "white", reason: "checkmate" },
    }),
    action: assertMove("e2e4", "e2", "e4"),
    outcome: "applied",
  });
  assert.ok(violations.some((v) => v.code === "CHS15-result-while-playing"));
});

test("和棋原因却带 winner → CHS15", () => {
  const start = startPosition();
  const violations = new ChessOracle().assert({
    before: observation(start),
    after: observation(play(start, ["e2e4"]), {
      status: "finished",
      moves: ["e2e4"],
      legalActions: [],
      result: { winner: "white", reason: "stalemate" },
    }),
    action: assertMove("e2e4", "e2", "e4"),
    outcome: "applied",
  });
  assert.ok(violations.some((v) => v.code === "CHS15-draw-with-winner"));
});

test("checkmate 却没有 winner → CHS15", () => {
  const start = startPosition();
  const violations = new ChessOracle().assert({
    before: observation(start),
    after: observation(play(start, ["e2e4"]), {
      status: "finished",
      moves: ["e2e4"],
      legalActions: [],
      result: { winner: null, reason: "checkmate" },
    }),
    action: assertMove("e2e4", "e2", "e4"),
    outcome: "applied",
  });
  assert.ok(violations.some((v) => v.code === "CHS15-checkmate-without-winner"));
});
