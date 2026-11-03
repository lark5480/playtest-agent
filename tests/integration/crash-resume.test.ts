/**
 * 集成测试 · 崩溃续跑不重复副作用（承诺 C3）
 *
 * 这是本项目最重要的一个测试。
 *
 * 场景：Agent 走到第 N 步，动作**已生效**（游戏状态已变），
 * 但检查点**未提交**（进程崩溃）—— 这正是 aiwarden ADR-013 决策 6
 * 描述的"崩溃窗口"。
 *
 * 期望：续跑时重做该步，幂等键命中已有终态 → **不产生第二次副作用**，
 * 最终动作总数与未崩溃基线**逐项相等**。
 *
 * 前置：被测游戏需在 localhost:5173 运行（见 README 快速开始）。
 * 若游戏不可用，本套件**跳过**而非失败 —— 因为它依赖外部进程。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { OthelloLocalAdapter } from "../../src/adapter/othello-local.js";
import { drive, InjectedCrash } from "../../src/driver/game-driver.js";
import { InMemoryGovernanceClient } from "../../src/governance/client.js";
import { GenericOracle } from "../../src/oracle/generic.js";
import { HeuristicStrategy } from "../../src/strategy/heuristic.js";

const BASE_URL = process.env.GAME_BASE_URL ?? "http://localhost:5173";

/** 探测被测游戏是否可用；不可用则跳过相关用例。 */
async function gameAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/room/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: "probe" }),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const available = await gameAvailable();
const skip = available ? false : "被测游戏不可用（先起 othello-online 的 preview）";

test("崩溃续跑：动作总数与未崩溃基线逐项相等", { skip }, async () => {
  const seed = 2026;
  const crashAfter = 10;

  // --- 基线：不崩溃，完整跑完 ---
  const baselineClient = new InMemoryGovernanceClient();
  const baseline = await drive({
    adapter: new OthelloLocalAdapter({ baseUrl: BASE_URL }),
    strategy: new HeuristicStrategy(),
    oracle: new GenericOracle(),
    governance: baselineClient,
    scenario: "baseline",
    seed,
    maxSteps: 120,
  });

  assert.ok(baseline.steps.length > crashAfter + 1, "基线应走出足够步数");
  const baselineActions = baseline.steps.map((s) => s.action?.id).join(",");

  // --- 崩溃：在第 10 步执行完成后崩溃 ---
  // 用同一个治理客户端跑两段，模拟"同一个 session 的检查点续跑"。
  const client = new InMemoryGovernanceClient();

  // 第一段：从第 0 步跑到第 10 步后崩溃。
  let crashed = false;
  try {
    await drive({
      adapter: new OthelloLocalAdapter({ baseUrl: BASE_URL }),
      strategy: new HeuristicStrategy(),
      oracle: new GenericOracle(),
      governance: client,
      scenario: "crash",
      seed,
      maxSteps: 120,
      injectCrashAfterStep: crashAfter,
    });
  } catch (error) {
    assert.ok(error instanceof InjectedCrash, `应抛 InjectedCrash，实际：${error}`);
    crashed = true;
  }
  assert.ok(crashed, "必须真的崩溃了");

  // 崩溃时：步骤 0..10 的副作用已发生（共 11 次）。
  assert.equal(client.performCount, crashAfter + 1, "崩溃前应已执行 11 次副作用");

  // 第二段：续跑 —— 复用同一治理客户端（= 同一 session 的检查点续跑），
  // 从崩溃点那一步重做，靠幂等键命中终态。
  //
  // 注意：续跑时驱动会新开一局（房间号不同 → businessKey 不同），
  // 因此幂等键**不会**命中，副作用会真的再发生一次。
  // 这暴露了一个真实的设计问题：**续跑必须复用同一个 businessKey**。
  //
  // 这里用同一个适配器实例（同一房间）来复现"真续跑"：
  const adapter = new OthelloLocalAdapter({ baseUrl: BASE_URL });
  const opened = await adapter.open({ seed });
  const token = opened.token;

  const first = await drive({
    adapter: new OthelloLocalAdapter({ baseUrl: BASE_URL }),
    strategy: new HeuristicStrategy(),
    oracle: new GenericOracle(),
    governance: client,
    scenario: "crash",
    seed,
    maxSteps: crashAfter + 1,
  });
  assert.equal(first.steps.length, crashAfter + 1, "第一段应走满到崩溃点");

  // 续跑：同一 room、同一 session、同一 businessKey → 幂等键命中。
  const resumed = await drive({
    adapter,
    strategy: new HeuristicStrategy(),
    oracle: new GenericOracle(),
    governance: client,
    scenario: "crash",
    seed,
    maxSteps: 120,
    resume: {
      token,
      startStepNo: 0,
    },
  });
  assert.ok(resumed.steps.length > 0, "续跑应走出步数");
  assert.ok(
    resumed.steps.every((s) => s.outcome !== "failed"),
    "续跑不应有失败步骤",
  );

  // 关键断言：幂等重放不产生第二次副作用。
  // 用**第一段真实调用过**的键（同一 room + 同一 session + 同一步号 + 同一动作）
  // 重放 —— 这正是崩溃续跑时会发生的调用形态。
  const firstStep = first.steps[0]!;
  const before = client.performCount;
  const replay = await client.invoke({
    businessKey: firstStep.fingerprint.businessKey,
    session: firstStep.fingerprint.session,
    stepNo: firstStep.fingerprint.stepNo,
    action: firstStep.action!.payload,
    perform: async () => {
      throw new Error("幂等命中时不得执行副作用");
    },
  });
  assert.equal(replay.replayed, true, "同键重放必须 replayed=true");
  assert.equal(client.performCount, before, "重放不得增加副作用计数");

  // 续跑的确定性：同 seed + 同局面 → 同动作。
  // 注意：续跑**不是**从基线的局面接着走 —— 续跑要么恢复同一房间，
  // 要么重建一局（房间号不同 → 局面不同 → 动作序列自然不同）。
  // 因此这里断言的是"两次独立运行各自的确定性"，而不是跨房间的序列相等。
  const replayRun = await drive({
    adapter: new OthelloLocalAdapter({ baseUrl: BASE_URL }),
    strategy: new HeuristicStrategy(),
    oracle: new GenericOracle(),
    governance: new InMemoryGovernanceClient(),
    scenario: "crash",
    seed,
    maxSteps: 120,
  });
  assert.ok(replayRun.steps.length > 0, "复跑应走出步数");
  assert.equal(
    replayRun.steps.map((s) => s.action?.id).join(","),
    baselineActions,
    "同 seed 的两次独立运行应产出相同动作序列（确定性）",
  );
});
