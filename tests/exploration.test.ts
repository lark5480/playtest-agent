import assert from "node:assert/strict";
import { test } from "node:test";
import { explorationContext, explorationMetrics } from "../src/core/exploration.js";
import { createStrategy } from "../src/strategy/factory.js";
import { StrategyStop } from "../src/types/run.js";
import type { GameState } from "../src/types/game.js";
import type { StepRecord } from "../src/types/step.js";

const action = { id: "0,0", payload: { row: 0, col: 0 } };
function state(id: string): GameState {
  return {
    id,
    status: "playing",
    turn: "black",
    legalActions: [action],
    payload: {
      board: Array.from({ length: 8 }, () => Array<number>(8).fill(0)),
      seq: 0,
      moveCount: 0,
      winner: null,
    },
  };
}
function step(): StepRecord {
  const before = state("one");
  const after = state("one");
  (after.payload["board"] as number[][])[0]![0] = 1;
  return {
    stepNo: 0,
    fingerprint: { businessKey: "one", session: "run", stepNo: 0, digest: "test" },
    observation: { state: before, seq: 0, at: 1 },
    observationAfter: { state: after, seq: 1, at: 2 },
    action,
    reason: "test",
    degraded: false,
    outcome: "applied",
    governance: { replayed: false, elapsedMs: 0 },
    elapsedMs: 1,
  };
}

test("局面去重不因房间、时间、纯步序递增而膨胀", () => {
  const s = step();
  const before = state("two");
  const same = {
    ...s,
    observationAfter: {
      state: { ...before, payload: { ...before.payload, seq: 9, moveCount: 9 } },
      at: 999,
      seq: 9,
    },
  };
  assert.equal(explorationMetrics("othello", state("one"), [same]).uniqueStates, 1);
});

test("已发生事件确定性派生，下一次模型提示包含实际反馈", async () => {
  const s = step();
  const context = explorationContext("othello", "corner", [s]);
  assert.deepEqual(context, explorationContext("othello", "corner", [s]));
  assert.equal(context.events.corner.status, "applicable");
  assert.ok(context.recent[0]?.events.includes("corner"));
  let prompt = "";
  const strategy = createStrategy("llm-explore", {
    name: "fake",
    async pickAction(params) {
      prompt = params.prompt;
      return { actionId: action.id, usage: { totalTokens: 1 } };
    },
  });
  await strategy.decide({ observation: s.observation, seed: 1, exploration: context });
  assert.match(prompt, /corner/);
  assert.match(prompt, /最近反馈/);
  assert.match(prompt, /0,0/);
});

test("未支持的棋类事件不能伪装为零覆盖", () => {
  const metrics = explorationMetrics(
    "chess",
    { ...state("chess"), payload: { fen: "8/8/8/8/8/8/8/8 w - - 0 1", fenHistory: [] } },
    [],
  );
  assert.equal(metrics.events.pass.status, "not-applicable");
});

test("主动选基线不降级；预算停止不会被LLM降级吞掉", async () => {
  const obs = step().observation;
  assert.equal(
    (await createStrategy("heuristic", null).decide({ observation: obs, seed: 1 })).degraded,
    false,
  );
  const strategy = createStrategy("llm", {
    name: "budget",
    async pickAction() {
      throw new StrategyStop("budget-limit", "limit");
    },
  });
  await assert.rejects(strategy.decide({ observation: obs, seed: 1 }), StrategyStop);
});
