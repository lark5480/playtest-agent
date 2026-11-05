/**
 * 单测 · 状态指纹与续跑判定
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { decideResumeAction } from "../src/core/resume.js";
import { stateHashOf } from "../src/core/state-hash.js";
import type { GameState } from "../src/types/game.js";

function state(over: Partial<GameState> = {}): GameState {
  return {
    id: "room1",
    status: "playing",
    turn: "black",
    legalActions: [],
    payload: { board: [[1, 2]], moveCount: 1, seq: 1 },
    ...over,
  };
}

test("状态哈希只吃 state（不含 observation 的 seq/at），且键序无关", () => {
  const a = state();
  const b = state({ payload: { seq: 1, moveCount: 1, board: [[1, 2]] } });
  assert.equal(stateHashOf(a), stateHashOf(b));
});

test("状态哈希对 payload 变化敏感", () => {
  assert.notEqual(stateHashOf(state()), stateHashOf(state({ payload: { board: [[2, 1]] } })));
});

test("续跑判定：命中 expectedAfter → replayed", () => {
  assert.equal(
    decideResumeAction({ currentHash: "after", beforeHash: "before", expectedAfterHash: "after" }),
    "replayed",
  );
});

test("续跑判定：命中 before → redo", () => {
  assert.equal(
    decideResumeAction({ currentHash: "before", beforeHash: "before", expectedAfterHash: "after" }),
    "redo",
  );
});

test("续跑判定：两者都不是 → diverged", () => {
  assert.equal(
    decideResumeAction({ currentHash: "other", beforeHash: "before", expectedAfterHash: "after" }),
    "diverged",
  );
});

test("续跑判定：没有投影时，状态变化即 diverged（不猜已生效）", () => {
  assert.equal(decideResumeAction({ currentHash: "after", beforeHash: "before" }), "diverged");
});
