import assert from "node:assert/strict";
import { after, test } from "node:test";

import { ChessArenaAdapter } from "../src/adapter/chess-arena.js";
import type { Action } from "../src/types/game.js";
import { startChessStubServer } from "./helpers/chess-stub-server.js";

const stub = await startChessStubServer();
after(async () => {
  await stub.close();
});

function adapter(): ChessArenaAdapter {
  return new ChessArenaAdapter({ baseUrl: stub.baseUrl, timeoutMs: 5000 });
}

test("open：进入 playing，白方先手，初始 20 个合法着", async () => {
  const { state } = await adapter().open({ seed: 1 });
  assert.equal(state.status, "playing");
  assert.equal(state.turn, "white");
  assert.equal(state.legalActions.length, 20);
  assert.ok(state.legalActions.some((action) => action.id === "e2e4"));
});

test("act：e2e4 生效并返回后置观察", async () => {
  const client = adapter();
  const { state, token } = await client.open({ seed: 2 });
  const action = state.legalActions.find((candidate) => candidate.id === "e2e4");
  assert.ok(action, "初始局面必须有 e2e4");

  const result = await client.act({ state, token, action });
  assert.equal(result.ok, true, result.error);
  assert.ok(result.observation);

  const observed = result.observation.state;
  assert.equal(observed.turn, "black");
  assert.equal(observed.payload["moveCount"], 1);
  assert.equal(
    observed.payload["fen"],
    "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
  );
  assert.ok(observed.legalActions.length > 0);
});

test("act：非法动作被拒绝，局面不变", async () => {
  const client = adapter();
  const { state, token } = await client.open({ seed: 3 });
  const bogus: Action = { id: "__bogus__", payload: { from: "e2", to: "e5" } };

  const result = await client.act({ state, token, action: bogus });
  assert.equal(result.ok, false);

  const current = await client.observe({ state, token });
  assert.equal(current.state.payload["moveCount"], 0);
  assert.equal(current.state.turn, "white");
});

test("resume：按 token 恢复已走子的对局；房间不存在时返回 null", async () => {
  const client = adapter();
  const { state, token } = await client.open({ seed: 4 });
  const action = state.legalActions[0]!;
  const result = await client.act({ state, token, action });
  assert.equal(result.ok, true, result.error);

  const resumed = await client.resume({ token });
  assert.ok(resumed);
  assert.equal(resumed.state.payload["moveCount"], 1);
  assert.equal(resumed.state.payload["fen"], result.observation?.state.payload["fen"]);

  const missing = await client.resume({
    token: JSON.stringify({ code: "NOPE00", whiteId: "", blackId: "" }),
  });
  assert.equal(missing, null);
});

test("act：429 限流等待后重试，不把限流当游戏失败", async () => {
  const client = new ChessArenaAdapter({
    baseUrl: stub.baseUrl,
    timeoutMs: 5000,
    rateLimitWaitMs: 10,
  });
  const { state, token } = await client.open({ seed: 7 });
  stub.failNextMoves(1);

  const action = state.legalActions.find((candidate) => candidate.id === "e2e4");
  assert.ok(action);
  const result = await client.act({ state, token, action });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.observation?.state.payload["moveCount"], 1);
});

test("isTerminal：正常开局不是终局", async () => {
  const client = adapter();
  const { state } = await client.open({ seed: 5 });
  assert.equal(client.isTerminal({ state }), false);
});

test("三次重复：服务端仍报 playing，适配器按本地历史判为和棋", async () => {
  // 假服务只判将死/逼和，不判历史型和棋 —— 正好用来验证本地判定真的参与了终局。
  const client = adapter();
  const { state, token } = await client.open({ seed: 8 });
  let current = state;

  const shuffle = ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"];
  for (const id of shuffle) {
    const action = current.legalActions.find((candidate) => candidate.id === id);
    assert.ok(action, `缺少合法着 ${id}`);
    const result = await client.act({ state: current, token, action });
    assert.equal(result.ok, true, result.error);
    current = result.observation!.state;
  }

  assert.equal(current.status, "finished");
  assert.equal(current.turn, null);
  assert.equal(current.legalActions.length, 0);
  assert.deepEqual(current.payload["result"], { winner: null, reason: "threefold" });
  assert.equal(client.isTerminal({ state: current }), true);

  const history = current.payload["fenHistory"];
  assert.ok(Array.isArray(history) && history.length === 9, "历史应含初始局面 + 8 步");
});

test("token 中的玩家凭证不出现在状态里", async () => {
  const client = adapter();
  const { state, token } = await client.open({ seed: 6 });
  const parsed = JSON.parse(token) as { whiteId: string; blackId: string };
  const serialized = JSON.stringify(state);
  assert.equal(serialized.includes(parsed.whiteId), false);
  assert.equal(serialized.includes(parsed.blackId), false);
});
