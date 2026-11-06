/**
 * 单测 · 驱动重放语义（P1-4）
 *
 * 两条关键路径：
 * 1. 治理报告重放、游戏状态已是执行后 → outcome=replayed，不重复执行；
 * 2. 治理报告重放、游戏状态仍是执行前 → 不能静默跳过，必须补偿执行并记 warning。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { GameAdapter } from "../src/adapter/game-adapter.js";
import { drive, InjectedCrash, ResumeDivergedError } from "../src/driver/game-driver.js";
import type { Checkpoint, CheckpointStore } from "../src/driver/checkpoint.js";
import { BudgetedLlmClient } from "../src/llm/budgeted-client.js";
import { StrategyStop } from "../src/types/run.js";
import { explorationContext } from "../src/core/exploration.js";
import { GenericOracle } from "../src/oracle/generic.js";
import type { Strategy } from "../src/strategy/strategy.js";
import type { Action, GameState, Observation } from "../src/types/game.js";
import type { GovernanceClient, GovernanceResult } from "../src/types/governance.js";

class MemoryStore implements CheckpointStore {
  readonly path = "<memory>";
  latest: Checkpoint | undefined;
  history: Checkpoint[] = [];
  removed = 0;
  save(value: Checkpoint): void {
    this.latest = structuredClone(value);
    this.history.push(this.latest);
  }
  remove(): void {
    this.removed++;
  }
}

const ACTION: Action = { id: "a", payload: { row: 0 } };
const S0: GameState = {
  id: "room1",
  status: "playing",
  turn: "black",
  legalActions: [ACTION],
  payload: { moveCount: 0 },
};
const S1: GameState = {
  id: "room1",
  status: "finished",
  turn: null,
  legalActions: [],
  payload: { moveCount: 1 },
};

class ScriptedAdapter implements GameAdapter {
  readonly name = "scripted";
  readonly supportsConditionalAct: boolean = true;
  projectAfter(): GameState {
    return S1;
  }
  async resume(): Promise<{ state: GameState }> {
    return { state: this.applied ? S1 : S0 };
  }
  public applied = false;
  public actCount = 0;

  async open(): Promise<{ state: GameState; token: string }> {
    return { state: S0, token: "t" };
  }

  async observe(): Promise<Observation> {
    return { state: this.applied ? S1 : S0, seq: this.applied ? 1 : 0, at: 1 };
  }

  async act(): Promise<{ ok: boolean; observation?: Observation }> {
    this.actCount += 1;
    this.applied = true;
    return { ok: true, observation: { state: S1, seq: 1, at: 1 } };
  }

  isTerminal(params: { state: GameState }): boolean {
    return params.state.status === "finished";
  }
}

class ReplayGovernance implements GovernanceClient {
  readonly name = "replay-fake";

  constructor(private readonly replayed: boolean) {}

  async invoke(params: {
    readonly businessKey: string;
    readonly session: string;
    readonly stepNo: number;
    readonly action: Readonly<Record<string, unknown>>;
    readonly perform: () => Promise<void>;
  }): Promise<GovernanceResult> {
    if (!this.replayed) await params.perform();
    return { businessKey: params.businessKey, replayed: this.replayed };
  }
}

function options(adapter: GameAdapter) {
  return {
    adapter,
    strategy,
    oracle: new GenericOracle(),
    governance: new ReplayGovernance(false),
    scenario: "stop",
    seed: 1,
    maxSteps: 1,
  };
}

test("末步恰好终局必须刷新，不额外询问策略", async () => {
  let decisions = 0;
  const result = await drive({
    ...options(new ScriptedAdapter()),
    strategy: {
      name: "count",
      async decide(p) {
        decisions += 1;
        return strategy.decide(p);
      },
    },
  });
  assert.equal(result.terminal, true);
  assert.equal(result.gameTerminal, true);
  assert.equal(result.stopReason, "game-finished");
  assert.equal(decisions, 1);
  assert.deepEqual(result.initialState, S0);
  assert.deepEqual(result.finalState, S1);
});

test("零步步限不是正常完成，新运行身份不能复用", async () => {
  const a = await drive({ ...options(new ScriptedAdapter()), maxSteps: 0 });
  const b = await drive({ ...options(new ScriptedAdapter()), maxSteps: 0 });
  assert.equal(a.terminal, false);
  assert.equal(a.stopReason, "step-limit");
  assert.notEqual(a.session, b.session);
});

test("执行失败立即停止而非换步重试", async () => {
  const adapter = new ScriptedAdapter();
  adapter.act = async () => {
    adapter.actCount += 1;
    return { ok: false };
  };
  const result = await drive({ ...options(adapter), maxSteps: 4 });
  assert.equal(adapter.actCount, 1);
  assert.equal(result.steps.length, 1);
  assert.equal(result.terminal, false);
  assert.equal(result.stopReason, "execution-failed");
});

const strategy: Strategy = {
  name: "first",
  async decide({ observation }) {
    const action = observation.state.legalActions[0] ?? null;
    return { action, reason: "first", degraded: false };
  },
};

test("零步 finished 不调用策略，仍校验状态", async () => {
  const adapter = new ScriptedAdapter();
  adapter.open = async () => ({ state: S1, token: "t" });
  const result = await drive({
    ...options(adapter),
    strategy: {
      name: "forbidden",
      async decide() {
        assert.fail("终局不得调用策略");
      },
    },
  });
  assert.equal(result.stopReason, "game-finished");
  assert.equal(result.steps.length, 0);
  assert.equal(adapter.actCount, 0);
  adapter.open = async () => ({ state: { ...S1, legalActions: [ACTION] }, token: "t" });
  const invalid = await drive({ ...options(adapter), maxSteps: 0 });
  assert.equal(invalid.stopReason, "assertion-failed");
  assert.equal(invalid.gameTerminal, true);
  assert.equal(invalid.findings[0]?.code, "G2-terminal-has-legal-actions");
  assert.equal(invalid.findings[0]?.stepNo, null);
});

test("playing 无动作是 stalled，不问策略", async () => {
  const adapter = new ScriptedAdapter();
  adapter.open = async () => ({ state: { ...S0, legalActions: [] }, token: "t" });
  const result = await drive({
    ...options(adapter),
    strategy: {
      name: "forbidden",
      async decide() {
        assert.fail("停滞不应问策略");
      },
    },
  });
  assert.equal(result.stopReason, "stalled");
  assert.equal(result.gameTerminal, false);
  assert.equal(adapter.actCount, 0);
});

test("非终局 null 立即策略停止", async () => {
  const adapter = new ScriptedAdapter();
  const result = await drive({
    ...options(adapter),
    strategy: {
      name: "null",
      async decide() {
        return { action: null, reason: "stop", degraded: false };
      },
    },
  });
  assert.equal(result.stopReason, "strategy-stopped");
  assert.equal(result.gameTerminal, false);
  assert.equal(adapter.actCount, 0);
});

for (const reason of ["budget-limit", "recording-exhausted", "state-diverged"] as const) {
  test(`StrategyStop ${reason} 不变成降级且没有副作用`, async () => {
    const adapter = new ScriptedAdapter();
    const result = await drive({
      ...options(adapter),
      strategy: {
        name: "stop",
        async decide() {
          throw new StrategyStop(reason, "SECRET-TOKEN");
        },
      },
    });
    assert.equal(result.stopReason, reason);
    assert.equal(result.steps.length, 0);
    assert.equal(adapter.actCount, 0);
    assert.ok(!JSON.stringify(result).includes("SECRET-TOKEN"));
  });
}

test("fatal 停止但不伪造 finished，保留结构化证据", async () => {
  const adapter = new ScriptedAdapter();
  adapter.act = async () => {
    adapter.actCount++;
    return {
      ok: true,
      observation: { state: { ...S0, payload: { moveCount: 1 } }, seq: 1, at: 1 },
    };
  };
  const result = await drive({
    ...options(adapter),
    maxSteps: 5,
    oracle: {
      name: "fatal",
      assert({ action }) {
        return action
          ? [
              {
                code: "bad",
                severity: "fatal",
                message: "bad",
                stepNo: null,
                evidence: [{ field: "board[0][0]", expected: 1, actual: 2 }],
              },
            ]
          : [];
      },
    },
  });
  assert.equal(result.stopReason, "assertion-failed");
  assert.equal(result.gameTerminal, false);
  assert.equal(adapter.actCount, 1);
  assert.deepEqual(result.findings[0]?.evidence, [
    { field: "board[0][0]", expected: 1, actual: 2 },
  ]);
});

test("最终状态检查发现 fatal 优先于 game-finished", async () => {
  const result = await drive({
    ...options(new ScriptedAdapter()),
    oracle: {
      name: "final",
      assert({ after, action }) {
        return action === null && after?.state.status === "finished"
          ? [{ code: "final", severity: "fatal", message: "invalid final", stepNo: null }]
          : [];
      },
    },
  });
  assert.equal(result.stopReason, "assertion-failed");
  assert.equal(result.gameTerminal, true);
});

test("预算预扣和结算保存当前步号、初态；正常收口不由 drive 删除", async () => {
  const store = new MemoryStore();
  let requests = 0;
  const budget = new BudgetedLlmClient(
    {
      name: "fake",
      async pickAction() {
        requests++;
        assert.equal(store.latest?.budget?.attempts[0]?.state, "in-flight");
        assert.equal(store.latest?.nextStepNo, 0);
        assert.deepEqual(store.latest?.initialState, S0);
        return { actionId: ACTION.id, usage: { totalTokens: 7 } };
      },
    },
    { maxCalls: 1 },
  );
  const result = await drive({
    ...options(new ScriptedAdapter()),
    budget,
    checkpoint: store,
    session: "pre-created",
    strategy: {
      name: "budget",
      async decide() {
        await budget.pickAction({ actions: [ACTION], prompt: "fake" });
        assert.equal(store.latest?.budget?.attempts[0]?.state, "settled");
        return { action: ACTION, reason: "fake", degraded: false };
      },
    },
  });
  assert.equal(requests, 1);
  assert.equal(result.session, "pre-created");
  assert.equal(result.budget?.attempts[0]?.tokens, 7);
  assert.ok(
    store.history.some((saved) => saved.pending && saved.budget?.attempts[0]?.state === "settled"),
  );
  assert.equal(store.latest?.nextStepNo, 1);
  assert.equal(store.latest?.pending, undefined);
  assert.equal(store.removed, 0);
});

test("预算检查点预扣写失败，底层请求与动作都为零", async () => {
  const store = new MemoryStore();
  const originalSave = store.save.bind(store);
  store.save = (value) => {
    if (value.budget?.attempts.length) throw new Error("disk full");
    originalSave(value);
  };
  let requests = 0;
  const budget = new BudgetedLlmClient(
    {
      name: "fake",
      async pickAction() {
        requests++;
        return { actionId: ACTION.id };
      },
    },
    { maxCalls: 1 },
  );
  const adapter = new ScriptedAdapter();
  await assert.rejects(
    drive({
      ...options(adapter),
      checkpoint: store,
      budget,
      strategy: {
        name: "budget",
        async decide() {
          await budget.pickAction({ actions: [ACTION], prompt: "fake" });
          return { action: ACTION, reason: "fake", degraded: false };
        },
      },
    }),
    /disk full/,
  );
  assert.equal(requests, 0);
  assert.equal(adapter.actCount, 0);
});

for (const branch of ["before", "after", "other"] as const) {
  test(`pending 恢复 ${branch} 分支只使用原动作并复用 session`, async () => {
    const adapter = new ScriptedAdapter();
    const store = new MemoryStore();
    await assert.rejects(
      drive({ ...options(adapter), checkpoint: store, injectCrashAfterStep: 0 }),
      InjectedCrash,
    );
    const saved = store.latest!;
    assert.equal(saved.steps.length, 0);
    assert.ok(saved.pending);
    adapter.applied = branch !== "before";
    if (branch === "other")
      adapter.resume = async () => ({ state: { ...S0, payload: { moveCount: 99 } } });
    const run = drive({
      ...options(adapter),
      checkpoint: store,
      resume: saved,
      strategy: {
        name: "forbidden",
        async decide() {
          assert.fail("pending 不得重决策");
        },
      },
    });
    if (branch === "other") {
      await assert.rejects(run, ResumeDivergedError);
      assert.equal(adapter.actCount, 1);
      assert.deepEqual(store.latest, saved);
    } else {
      const result = await run;
      assert.equal(result.session, saved.session);
      assert.equal(result.gameTerminal, true);
      assert.equal(result.steps.length, 1);
      assert.equal(result.steps[0]?.outcome, branch === "after" ? "replayed" : "applied");
      assert.equal(adapter.actCount, branch === "after" ? 1 : 2);
    }
  });
}

test("失败保留 pending 与原步号；无条件写能力的恢复禁止重试", async () => {
  class UnsafeAdapter extends ScriptedAdapter {
    override readonly supportsConditionalAct = false;
  }
  const adapter = new UnsafeAdapter();
  adapter.act = async () => {
    adapter.actCount++;
    throw new Error("SECRET-TOKEN");
  };
  const store = new MemoryStore();
  const result = await drive({ ...options(adapter), checkpoint: store, maxSteps: 4 });
  assert.equal(result.stopReason, "execution-failed");
  assert.ok(!JSON.stringify(result).includes("SECRET-TOKEN"));
  assert.equal(store.latest?.nextStepNo, 0);
  assert.equal(store.latest?.steps.length, 0);
  assert.equal(store.latest?.pending?.action.id, ACTION.id);
  const resumed = await drive({ ...options(adapter), checkpoint: store, resume: store.latest! });
  assert.equal(resumed.stopReason, "execution-failed");
  assert.equal(adapter.actCount, 1);
  assert.ok(store.latest?.pending);
});

test("治理 replay 的 other 状态或无条件写保护均不得补偿", async () => {
  class UnsafeAdapter extends ScriptedAdapter {
    override readonly supportsConditionalAct = false;
  }
  for (const adapter of [new UnsafeAdapter(), new ScriptedAdapter()]) {
    if (adapter.supportsConditionalAct)
      adapter.observe = async () => ({
        state: { ...S0, payload: { moveCount: 99 } },
        seq: 1,
        at: 1,
      });
    const result = await drive({
      ...options(adapter),
      governance: new ReplayGovernance(true),
      maxSteps: 4,
    });
    assert.equal(result.stopReason, "execution-failed");
    assert.equal(result.steps.length, 1);
    assert.equal(adapter.actCount, 0);
  }
});

test("遗留 in-flight 预算恢复为 unknown，pending 收尾不重问模型", async () => {
  const store = new MemoryStore();
  const adapter = new ScriptedAdapter();
  await assert.rejects(
    drive({ ...options(adapter), checkpoint: store, injectCrashAfterStep: 0 }),
    InjectedCrash,
  );
  const saved = {
    ...store.latest!,
    budget: { maxCalls: 1, attempts: [{ callId: 1, state: "in-flight" as const }] },
  };
  let requests = 0;
  const budget = new BudgetedLlmClient(
    {
      name: "fake",
      async pickAction() {
        requests++;
        return { actionId: ACTION.id };
      },
    },
    { maxCalls: 1, initial: saved.budget },
  );
  const result = await drive({
    ...options(adapter),
    budget,
    checkpoint: store,
    resume: saved,
    strategy: {
      name: "forbidden",
      async decide() {
        assert.fail("pending 不重问模型");
      },
    },
  });
  assert.equal(requests, 0);
  assert.equal(result.stopReason, "game-finished");
  assert.equal(result.budget?.attempts[0]?.state, "unknown");
  assert.equal(store.latest?.budget?.attempts[0]?.state, "unknown");
});

test("无 pending 的恢复也校验状态链，发散不得问策略", async () => {
  const adapter = new ScriptedAdapter();
  const store = new MemoryStore();
  await drive({ ...options(adapter), checkpoint: store, maxSteps: 0 });
  adapter.applied = true;
  await assert.rejects(
    drive({ ...options(adapter), checkpoint: store, resume: store.latest! }),
    ResumeDivergedError,
  );
  assert.equal(adapter.actCount, 0);
});

test("探索上下文来自已记录步骤并进入 decide", async () => {
  let called = false;
  await drive({
    ...options(new ScriptedAdapter()),
    exploration: { game: "othello", target: "corner" },
    strategy: {
      name: "explore",
      async decide(params) {
        called = true;
        assert.deepEqual(params.exploration, explorationContext("othello", "corner", []));
        return strategy.decide(params);
      },
    },
  });
  assert.equal(called, true);
});

test("治理重放 + 游戏已是执行后 → outcome=replayed，不重复调用 act", async () => {
  const adapter = new ScriptedAdapter();
  adapter.applied = true; // 动作此前已经生效
  const result = await drive({
    adapter,
    strategy,
    oracle: new GenericOracle(),
    governance: new ReplayGovernance(true),
    scenario: "replay",
    seed: 1,
    maxSteps: 2,
  });

  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]?.outcome, "replayed");
  assert.equal(result.steps[0]?.governance.replayed, true);
  assert.equal(adapter.actCount, 0, "重放不得再调用 act");
});

test("治理重放 + 游戏仍是执行前 → 补偿执行并记 G7 warning", async () => {
  const adapter = new ScriptedAdapter(); // applied=false
  const result = await drive({
    adapter,
    strategy,
    oracle: new GenericOracle(),
    governance: new ReplayGovernance(true),
    scenario: "repair",
    seed: 1,
    maxSteps: 2,
  });

  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]?.outcome, "applied");
  assert.equal(adapter.actCount, 1, "状态未变时必须补偿执行游戏动作");
  assert.ok(
    result.findings.some((finding) => finding.code === "G7-governance-replayed-before-game-state"),
    "必须显式记录治理账与游戏状态曾不一致",
  );
});
