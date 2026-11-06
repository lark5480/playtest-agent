/**
 * 单测 · 驱动核心（地基冻结契约 ① ④）
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { driveMeta, isTerminal, nextFingerprint, planNextStep } from "../src/core/driver-core.js";
import type { GameState, Observation } from "../src/types/game.js";

const context = { businessKey: "room1", session: "s1", seed: 1 };

function state(over: Partial<GameState> = {}): GameState {
  return {
    id: "room1",
    status: "playing",
    turn: "black",
    legalActions: [{ id: "m1", payload: { row: 1, col: 1 } }],
    payload: {},
    ...over,
  };
}

function observation(s: GameState, seq = 0): Observation {
  return { state: s, seq, at: 1_700_000_000_000 + seq };
}

test("finished 状态判为终局", () => {
  assert.equal(isTerminal(state({ status: "finished" })), true);
});

test("无合法动作但未 finished 是停滞，不是游戏终局", () => {
  assert.equal(isTerminal(state({ legalActions: [] })), false);
});

test("planNextStep 拒绝同 ID 异 payload", () => {
  assert.throws(
    () =>
      planNextStep({
        context,
        stepNo: 0,
        observation: observation(state()),
        decision: {
          action: { id: "m1", payload: { row: 7, col: 7 } },
          reason: "x",
          degraded: false,
        },
      }),
    /非法动作/,
  );
});

test("planNextStep 拒绝非终局 null 动作", () => {
  assert.throws(
    () =>
      planNextStep({
        context,
        stepNo: 0,
        observation: observation(state()),
        decision: { action: null, reason: "x", degraded: false },
      }),
    /空动作/,
  );
});

test("planNextStep 接受键序不同的同一 payload", () => {
  const plan = planNextStep({
    context,
    stepNo: 0,
    observation: observation(state()),
    decision: { action: { id: "m1", payload: { col: 1, row: 1 } }, reason: "x", degraded: false },
  });
  assert.equal(plan.terminal, false);
});

test("有合法动作且未 finished 不判终局", () => {
  assert.equal(isTerminal(state()), false);
});

test("turn 为 null 且未 finished 不判终局", () => {
  assert.equal(isTerminal(state({ turn: null })), false);
});

test("planNextStep 拒绝策略臆造的动作", () => {
  assert.throws(
    () =>
      planNextStep({
        context,
        stepNo: 0,
        observation: observation(state()),
        decision: { action: { id: "bogus", payload: {} }, reason: "x", degraded: false },
      }),
    /非法动作/,
    "策略返回不在合法集内的动作必须抛错",
  );
});

test("planNextStep 接受合法动作并产出指纹", () => {
  const plan = planNextStep({
    context,
    stepNo: 2,
    observation: observation(state()),
    decision: { action: { id: "m1", payload: { row: 1, col: 1 } }, reason: "ok", degraded: false },
  });
  assert.equal(plan.stepNo, 2);
  assert.equal(plan.action?.id, "m1");
  assert.equal(plan.terminal, false);
  assert.equal(plan.fingerprint.businessKey, "room1");
  assert.equal(plan.fingerprint.stepNo, 2);
});

test("终局时产出空动作与终止标记", () => {
  const plan = planNextStep({
    context,
    stepNo: 5,
    observation: observation(state({ status: "finished", legalActions: [] })),
    decision: { action: null, reason: "终局", degraded: false },
  });
  assert.equal(plan.action, null);
  assert.equal(plan.terminal, true);
});

test("指纹只依赖业务键/会话/步号/动作，不含时间与随机", () => {
  const a = nextFingerprint(context, 1, { id: "m", payload: { a: 1 } });
  const b = nextFingerprint(context, 1, { id: "m", payload: { a: 1 } });
  assert.deepEqual(a, b);
});

test("driveMeta 汇总步数与终局", () => {
  const steps = [{ action: null }, { action: { id: "x", payload: {} } }];
  assert.deepEqual(driveMeta(steps, false), { stepCount: 2, terminal: false });
});
