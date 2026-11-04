/**
 * 集成测试 · 并发冲突（乐观并发）
 *
 * 找的是**真实存在的缺陷类型**：两个客户端同时对同一房间落子，
 * 服务端应拒绝其中一个（409），而不是让两方状态互相覆盖。
 *
 * othello 用 `expectedUpdatedAt` 做乐观并发：
 * `server/mockApi.ts` 的 move 分支里 `state.updatedAt !== expectedUpdatedAt` → 409。
 *
 * 这个场景在**单 Agent 串行跑**时永远碰不到 —— 必须两个客户端并发。
 * 它也解释了为什么"人工试玩"难以覆盖这类问题：一个人不会同时落两手。
 *
 * 前置：被测游戏需在 localhost:5173 运行（见 README 快速开始）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { OthelloLocalAdapter } from "../../src/adapter/othello-local.js";
import { integrationGate } from "../helpers/integration-gate.js";

const BASE_URL = process.env.GAME_BASE_URL ?? "http://localhost:5173";

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

/**
 * 造一个"两个客户端进同一房间"的场景。
 *
 * 关键：必须**共享同一个 roomId** —— 各自开新房就不是并发了。
 */
async function sameRoomPair(): Promise<{
  a: { adapter: OthelloLocalAdapter; token: string };
  b: { adapter: OthelloLocalAdapter; token: string };
}> {
  const a = new OthelloLocalAdapter({ baseUrl: BASE_URL });
  const b = new OthelloLocalAdapter({ baseUrl: BASE_URL });

  // A 建房并持黑方身份（**不占白方座位** —— 否则第二个客户端进不来）
  const openedA = await a.createRoom({ seed: 1 });
  const roomId = openedA.state.id;

  // B 以白方身份加入**同一个房间**
  const joinedB = await b.join({ roomId, playerId: `white-${roomId}` });

  return {
    a: { adapter: a, token: openedA.token },
    b: { adapter: b, token: joinedB.token },
  };
}

test("并发落子：同一房间两个客户端同时落子，必须恰好一个被接受", { skip: gate.skip }, async () => {
  gate.precheck?.();
  const { a, b } = await sameRoomPair();

  const obsA = await a.adapter.observe({
    state: { id: "", status: "playing", turn: null, legalActions: [], payload: {} },
    token: a.token,
  });
  const obsB = await b.adapter.observe({
    state: { id: "", status: "playing", turn: null, legalActions: [], payload: {} },
    token: b.token,
  });

  const actionA = obsA.state.legalActions[0];
  const actionB = obsB.state.legalActions[0];
  assert.ok(actionA, "A 应有合法动作");
  assert.ok(actionB, "B 应有合法动作");

  // 同时落子
  const [resA, resB] = await Promise.all([
    a.adapter.act({ state: obsA.state, token: a.token, action: actionA }),
    b.adapter.act({ state: obsB.state, token: b.token, action: actionB }),
  ]);

  const accepted = [resA, resB].filter((r) => r.ok).length;
  const rejected = [resA, resB].filter((r) => !r.ok).length;

  assert.equal(accepted + rejected, 2, "两个客户端都应有明确结果，不能静默无响应");
  assert.equal(accepted, 1, "并发落子必须恰好一个被接受（乐观并发保护生效）");
  assert.equal(rejected, 1, "被拒绝的一方必须给出错误原因");

  // 被拒绝的那次必须带明确原因（对齐 othello 的 409 语义）。
  for (const r of [resA, resB]) {
    if (!r.ok) {
      assert.ok(r.error, "拒绝必须带错误原因");
      assert.match(r.error, /409|conflict/i, `错误原因应指向并发冲突，实际：${r.error}`);
    }
  }
});

test("串行落子：同一房间第二个客户端用过期局面落子 → 409 冲突", { skip: gate.skip }, async () => {
  gate.precheck?.();
  const { a, b } = await sameRoomPair();

  const obsA = await a.adapter.observe({
    state: { id: "", status: "playing", turn: null, legalActions: [], payload: {} },
    token: a.token,
  });
  const obsB = await b.adapter.observe({
    state: { id: "", status: "playing", turn: null, legalActions: [], payload: {} },
    token: b.token,
  });

  // A 先走（合法，黑方回合）
  const first = await a.adapter.act({
    state: obsA.state,
    token: a.token,
    action: obsA.state.legalActions[0]!,
  });
  assert.ok(first.ok, `A 的合法落子应成功：${first.error ?? ""}`);

  // B 用**过期局面**（A 落子前观察到的）落子：
  // expectedUpdatedAt 已过期 → 服务端必须拒绝（409），不得静默接受。
  const stale = await b.adapter.act({
    state: obsB.state,
    token: b.token,
    action: obsB.state.legalActions[0]!,
  });

  assert.equal(stale.ok, false, "过期局面的落子必须被拒绝");
  assert.ok(stale.error, "拒绝必须带错误原因");
  assert.match(stale.error, /409|conflict/i, `错误原因应指向并发冲突，实际：${stale.error}`);

  // 且状态未被这次被拒的落子推进（moveCount 仍为 1）
  const after = await b.adapter.observe({
    state: { id: "", status: "playing", turn: null, legalActions: [], payload: {} },
    token: b.token,
  });
  assert.equal(Number(after.state.payload["moveCount"]), 1, "被拒绝的落子不得推进状态");
});
