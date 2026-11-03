/**
 * 单测 · 通用 Oracle
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { GenericOracle } from "../src/oracle/generic.js";
import type { GameState, Observation } from "../src/types/game.js";

function obs(state: Partial<GameState> = {}, seq = 0): Observation {
  return {
    state: {
      id: "room1",
      status: "playing",
      turn: "black",
      legalActions: [{ id: "a", payload: {} }],
      payload: {},
      ...state,
    },
    seq,
    at: 1,
  };
}

const oracle = new GenericOracle();

test("正常一步无违规", () => {
  const violations = oracle.assert({
    before: obs(),
    after: obs({ turn: "white", payload: { moved: true } }, 1),
    action: { id: "a", payload: {} },
    outcome: "applied",
  });
  assert.deepEqual(violations, []);
});

test("G4：失败动作伴随状态变化 → fatal", () => {
  const violations = oracle.assert({
    before: obs(),
    after: obs({ payload: { changed: true } }, 1),
    action: { id: "a", payload: {} },
    outcome: "failed",
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.code, "G4-failed-step-changed-state");
  assert.equal(violations[0]?.severity, "fatal");
});

test("G4：失败动作但状态未变 → 无违规", () => {
  const violations = oracle.assert({
    before: obs(),
    after: obs({}, 1),
    action: { id: "a", payload: {} },
    outcome: "rejected",
  });
  assert.deepEqual(violations, []);
});

test("G3：观察序号回退 → fatal", () => {
  const violations = oracle.assert({
    before: obs({}, 5),
    after: obs({}, 2),
    action: { id: "a", payload: {} },
    outcome: "applied",
  });
  assert.equal(violations[0]?.code, "G3-observation-seq-regressed");
});

test("G2：终局仍有合法动作 → fatal", () => {
  const violations = oracle.assert({
    before: obs(),
    after: obs({ status: "finished" }, 1),
    action: { id: "a", payload: {} },
    outcome: "applied",
  });
  assert.equal(violations[0]?.code, "G2-terminal-has-legal-actions");
});

test("G1：回合切换到无合法动作的一方 → fatal（对局会卡死）", () => {
  const violations = oracle.assert({
    before: obs({ turn: "black" }),
    after: obs({ turn: "white", legalActions: [], payload: { moved: true } }, 1),
    action: { id: "a", payload: {} },
    outcome: "applied",
  });
  assert.equal(violations[0]?.code, "G1-new-turn-has-no-legal-moves");
});

test("G1：回合正常切换且新执子方有合法动作 → 无违规", () => {
  const violations = oracle.assert({
    before: obs({ turn: "black" }),
    after: obs({ turn: "white", payload: { moved: true } }, 1),
    action: { id: "a", payload: {} },
    outcome: "applied",
  });
  assert.deepEqual(violations, []);
});

test("G1：执子方未变 → 通用层不判（跳过规则由游戏特异 Oracle 负责）", () => {
  // 通用层无法区分"合法跳过"与"该换没换"，因此不做判定 ——
  // 硬判就是误报（othello 的跳过规则曾导致一次误报）。
  const violations = oracle.assert({
    before: obs({ turn: "black" }),
    after: obs({ turn: "black", payload: { moved: true } }, 1),
    action: { id: "a", payload: {} },
    outcome: "applied",
  });
  assert.deepEqual(violations, []);
});

test("G1：终局时执子方未变不算违规", () => {
  const violations = oracle.assert({
    before: obs({ turn: "black" }),
    after: obs(
      { turn: "black", status: "finished", legalActions: [], payload: { moved: true } },
      1,
    ),
    action: { id: "a", payload: {} },
    outcome: "applied",
  });
  assert.deepEqual(violations, []);
});
