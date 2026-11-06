import assert from "node:assert/strict";
import { test } from "node:test";
import { BatchBudget, BudgetedLlmClient } from "../src/llm/budgeted-client.js";
import type { LlmClient, LlmPickResult } from "../src/strategy/llm.js";
import { StrategyStop } from "../src/types/run.js";

const input = { actions: [{ id: "2,3", payload: { row: 2, col: 3 } }], prompt: "test" };
function fake(result: LlmPickResult = { actionId: "2,3", usage: { totalTokens: 10 } }) {
  let calls = 0;
  const client: LlmClient = {
    name: "fake",
    async pickAction() {
      calls += 1;
      return result;
    },
  };
  return { client, calls: () => calls };
}

test("预算先保存预扣，再请求；硬上限阻止下一请求", async () => {
  const f = fake();
  const budget = new BudgetedLlmClient(f.client, { maxCalls: 1 });
  const order: string[] = [];
  budget.bindPersistence(() => order.push(`${f.calls()}:${budget.snapshot().attempts[0]?.state}`));
  await budget.pickAction(input);
  assert.deepEqual(order, ["0:in-flight", "1:settled"]);
  await assert.rejects(budget.pickAction(input), StrategyStop);
  assert.equal(f.calls(), 1);
});

test("预扣落盘失败不发请求且不能通过重试退还额度", async () => {
  const f = fake();
  const budget = new BudgetedLlmClient(f.client, { maxCalls: 3 });
  budget.bindPersistence(() => {
    throw new Error("disk full");
  });
  await assert.rejects(budget.pickAction(input), StrategyStop);
  await assert.rejects(budget.pickAction(input), StrategyStop);
  assert.equal(f.calls(), 0);
  assert.equal(budget.snapshot().attempts.length, 1);
});

test("未知用量阻止后续请求，不伪造零tokens", async () => {
  const f = fake({ actionId: "2,3" });
  const budget = new BudgetedLlmClient(f.client, { maxCalls: 3 });
  budget.bindPersistence(() => {});
  await budget.pickAction(input);
  assert.deepEqual(budget.snapshot().attempts, [{ callId: 1, state: "unknown" }]);
  await assert.rejects(budget.pickAction(input), StrategyStop);
  assert.equal(f.calls(), 1);
});

test("非法输出仍保留已知usage，token软线最多跨一个请求", async () => {
  const f = fake({ actionId: null, usage: { totalTokens: 12 } });
  const budget = new BudgetedLlmClient(f.client, { maxCalls: 4, tokenLimit: 10 });
  budget.bindPersistence(() => {});
  assert.equal((await budget.pickAction(input)).actionId, null);
  assert.equal(budget.snapshot().attempts[0]?.tokens, 12);
  await assert.rejects(budget.pickAction(input), StrategyStop);
  assert.equal(f.calls(), 1);
});

test("恢复in-flight不退款且不重发；配置变更拒绝", async () => {
  const f = fake();
  const initial = { maxCalls: 2, attempts: [{ callId: 1, state: "in-flight" as const }] };
  const budget = new BudgetedLlmClient(f.client, { maxCalls: 2, initial });
  budget.bindPersistence(() => {});
  await assert.rejects(budget.pickAction(input), StrategyStop);
  assert.equal(budget.snapshot().attempts[0]?.state, "unknown");
  assert.equal(f.calls(), 0);
  assert.throws(() => new BudgetedLlmClient(f.client, { maxCalls: 3, initial }), /不匹配/);
});

test("不同seed客户端共享整批上限", async () => {
  const f = fake();
  const batch = new BatchBudget(1);
  const first = new BudgetedLlmClient(f.client, { maxCalls: 2, batch });
  const second = new BudgetedLlmClient(f.client, { maxCalls: 2, batch });
  first.bindPersistence(() => {});
  second.bindPersistence(() => {});
  await first.pickAction(input);
  await assert.rejects(second.pickAction(input), StrategyStop);
  assert.equal(batch.usedCalls, 1);
  assert.equal(f.calls(), 1);
});

test("底层失败后记unknown并停止后续请求", async () => {
  let calls = 0;
  const budget = new BudgetedLlmClient(
    {
      name: "broken",
      async pickAction() {
        calls++;
        throw new Error("credential-marker");
      },
    },
    { maxCalls: 3 },
  );
  budget.bindPersistence(() => {});
  await assert.rejects(
    budget.pickAction(input),
    (error: Error) => !error.message.includes("credential-marker"),
  );
  await assert.rejects(budget.pickAction(input), StrategyStop);
  assert.equal(calls, 1);
  assert.equal(budget.snapshot().attempts[0]?.state, "unknown");
});
