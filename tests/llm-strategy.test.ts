/**
 * 单测 · LLM 策略的降级语义（承诺 C4）
 *
 * 三条必须成立：
 * 1. 模型不可用 → 显式降级（degraded=true + 原因），**不静默**；
 * 2. 降级后仍返回**合法**动作（游戏仍可玩）；
 * 3. 模型返回非法动作 → 也降级（不采纳越界动作）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { LlmStrategy, type LlmClient, type LlmPickResult } from "../src/strategy/llm.js";
import type { Observation } from "../src/types/game.js";

function observation(): Observation {
  return {
    state: {
      id: "room1",
      status: "playing",
      turn: "black",
      legalActions: [
        { id: "a", payload: { row: 1 } },
        { id: "b", payload: { row: 2 } },
      ],
      payload: {},
    },
    seq: 0,
    at: 1,
  };
}

test("无模型客户端 → 显式降级且仍给出合法动作", async () => {
  const strategy = new LlmStrategy(null);
  const d = await strategy.decide({ observation: observation(), seed: 1 });
  assert.equal(d.degraded, true, "必须标记降级");
  assert.ok(d.degradedReason, "必须写明降级原因");
  assert.ok(d.action, "降级后仍要给出动作（游戏仍可玩）");
  const obs = observation();
  assert.ok(obs.state.legalActions.some((a) => a.id === d.action?.id));
});

test("模型调用失败 → 降级且不抛错", async () => {
  const failing: LlmClient = {
    name: "failing",
    pickAction: async () => {
      throw new Error("连接被拒");
    },
  };
  const strategy = new LlmStrategy(failing);
  const d = await strategy.decide({ observation: observation(), seed: 1 });
  assert.equal(d.degraded, true);
  assert.equal(d.degradedReason, "模型调用失败");
  assert.ok(d.action, "降级后仍要给出动作");
});

test("模型返回非法动作 → 降级且不采纳", async () => {
  const rogue: LlmClient = {
    name: "rogue",
    pickAction: async () => ({
      actionId: "not-a-legal-action",
      usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 },
    }),
  };
  const strategy = new LlmStrategy(rogue);
  const d = await strategy.decide({ observation: observation(), seed: 1 });
  assert.equal(d.degraded, true);
  assert.notEqual(d.action?.id, "not-a-legal-action", "不得采纳越界动作");
  assert.ok(d.action, "降级后仍要给出合法动作");
  assert.equal(d.llmTokens, 6, "越界动作也消耗了模型 token，必须入账");
  assert.equal(d.model, "rogue");
});

test("模型正常返回合法动作 → 不降级且记录 usage", async () => {
  const good: LlmClient = {
    name: "good",
    pickAction: async () => ({
      actionId: "b",
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    }),
  };
  const strategy = new LlmStrategy(good);
  const d = await strategy.decide({ observation: observation(), seed: 1 });
  assert.equal(d.degraded, false);
  assert.equal(d.action?.id, "b");
  assert.equal(d.llmTokens, 7);
  assert.equal(d.model, "good");
});

test("模型超时 → 降级（不无限等待）", async () => {
  const slow: LlmClient = {
    name: "slow",
    pickAction: ({ signal }) =>
      new Promise<LlmPickResult>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  };
  const strategy = new LlmStrategy(slow, 50);
  const d = await strategy.decide({ observation: observation(), seed: 1 });
  assert.equal(d.degraded, true);
  assert.ok(d.degradedReason?.includes("超时"));
  assert.ok(d.action);
});

test("无合法动作 → 返回 null，不降级", async () => {
  const strategy = new LlmStrategy(null);
  const obs = observation();
  const empty: Observation = {
    ...obs,
    state: { ...obs.state, legalActions: [] },
  };
  const d = await strategy.decide({ observation: empty, seed: 1 });
  assert.equal(d.action, null);
  assert.equal(d.degraded, false);
});
