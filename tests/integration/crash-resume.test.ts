/**
 * 集成测试 · 崩溃续跑（检查点 + pending 意图）
 *
 * 场景：Agent 走到第 N 步，动作**已生效**，但检查点只留下 pending 意图
 * （模拟"动作已生效、committed 未提交"的窗口）。
 *
 * 期望：恢复时用 after 状态哈希判定该步已生效 → 记 replayed、不重复落子；
 * 后续动作与未崩溃基线逐项相等（无状态 PRNG 保证）。
 *
 * 前置：othello-online 需在 localhost:5173 运行；不可达时按 gate 规则跳过。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { OthelloLocalAdapter } from "../../src/adapter/othello-local.js";
import type { Checkpoint, CheckpointStore } from "../../src/driver/checkpoint.js";
import { drive, InjectedCrash } from "../../src/driver/game-driver.js";
import { InMemoryGovernanceClient } from "../../src/governance/client.js";
import { GenericOracle } from "../../src/oracle/generic.js";
import { HeuristicStrategy } from "../../src/strategy/heuristic.js";
import { integrationGate } from "../helpers/integration-gate.js";

const BASE_URL = process.env.GAME_BASE_URL ?? "http://localhost:5173";

class MemoryCheckpointStore implements CheckpointStore {
  public readonly path = "<memory>";
  public latest: Checkpoint | undefined;

  save(checkpoint: Checkpoint): void {
    this.latest = checkpoint;
  }

  remove(): void {
    this.latest = undefined;
  }
}

async function gameAvailable(): Promise<{ ok: boolean; reason: string }> {
  try {
    const res = await fetch(`${BASE_URL}/api/room/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: "probe" }),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok
      ? { ok: true, reason: "" }
      : { ok: false, reason: `othello-online 返回 HTTP ${res.status}（${BASE_URL}）` };
  } catch (error) {
    return {
      ok: false,
      reason: `othello-online 不可达（${BASE_URL}）：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const probe = await gameAvailable();
const gate = integrationGate({
  dependency: "othello-online",
  available: probe.ok,
  reason: probe.reason,
});

test(
  "崩溃续跑：pending 步判定为 replayed，后续动作与基线逐项相等",
  { skip: gate.skip },
  async () => {
    gate.precheck?.();
    const seed = 2026;
    const crashAfter = 10;
    const maxSteps = 40;

    // --- 基线：不崩溃，完整跑完 ---
    const baseline = await drive({
      adapter: new OthelloLocalAdapter({ baseUrl: BASE_URL }),
      strategy: new HeuristicStrategy(),
      oracle: new GenericOracle(),
      governance: new InMemoryGovernanceClient(),
      scenario: "baseline",
      seed,
      maxSteps,
    });
    assert.ok(baseline.steps.length > crashAfter + 1, "基线应走出足够步数");
    const baselineActions = baseline.steps.map((step) => step.action?.id);

    // --- 崩溃：在第 10 步执行后、committed 之前中断 ---
    const store = new MemoryCheckpointStore();
    const crashAdapter = new OthelloLocalAdapter({ baseUrl: BASE_URL });
    let crashed = false;
    try {
      await drive({
        adapter: crashAdapter,
        strategy: new HeuristicStrategy(),
        oracle: new GenericOracle(),
        governance: new InMemoryGovernanceClient(),
        scenario: "crash",
        seed,
        maxSteps,
        checkpoint: store,
        injectCrashAfterStep: crashAfter,
      });
    } catch (error) {
      assert.ok(error instanceof InjectedCrash, `应抛 InjectedCrash，实际：${error}`);
      crashed = true;
    }
    assert.ok(crashed, "必须真的崩溃了");

    const checkpoint = store.latest;
    assert.ok(checkpoint, "崩溃后必须留下检查点");
    assert.ok(checkpoint.pending, "检查点必须留下 pending 意图");
    assert.equal(checkpoint.pending.stepNo, crashAfter);
    assert.equal(checkpoint.steps.length, crashAfter, "committed 步应只到崩溃前一步");
    assert.equal(
      checkpoint.pending.expectedAfterHash !== undefined,
      true,
      "应能本地投影 after 状态",
    );

    // --- 续跑：新进程 = 新适配器 + 新的内存治理（旧幂等状态已丢失） ---
    const resumed = await drive({
      adapter: new OthelloLocalAdapter({ baseUrl: BASE_URL }),
      strategy: new HeuristicStrategy(),
      oracle: new GenericOracle(),
      governance: new InMemoryGovernanceClient(),
      scenario: "crash",
      seed,
      maxSteps,
      resume: checkpoint,
      checkpoint: store,
    });

    assert.equal(resumed.businessKey, checkpoint.businessKey, "续跑必须复用同一对局");
    assert.ok(
      resumed.steps.every((step) => step.outcome !== "failed"),
      "续跑不应出现失败步",
    );
    assert.equal(resumed.steps[crashAfter]?.outcome, "replayed", "pending 步应判定为重放");
    assert.equal(resumed.steps[crashAfter]?.governance.replayed, true);

    assert.deepEqual(
      resumed.steps.map((step) => step.action?.id),
      baselineActions,
      "续跑的动作序列应与未崩溃基线逐项相等（无状态 PRNG）",
    );
    assert.equal(resumed.steps.length, baseline.steps.length, "续跑应走到与基线相同的步数");
  },
);
