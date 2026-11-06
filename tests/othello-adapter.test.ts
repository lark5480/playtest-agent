import assert from "node:assert/strict";
import { after, test } from "node:test";

import { OthelloLocalAdapter } from "../src/adapter/othello-local.js";
import { startOthelloStubServer } from "../src/demo/othello-server.js";

const stub = await startOthelloStubServer();
after(async () => {
  await stub.close();
});

function adapter(): OthelloLocalAdapter {
  return new OthelloLocalAdapter({ baseUrl: stub.baseUrl, timeoutMs: 5000 });
}

test("act：后续观察不能刷新旧局面的条件写版本", async () => {
  const client = adapter();
  const { state, token } = await client.open({ seed: 17 });
  const action = state.legalActions[0]!;
  const first = await client.act({ state, token, action });
  assert.equal(first.ok, true);
  await client.observe({ state: first.observation!.state, token });
  const stale = await client.act({ state, token, action });
  assert.equal(stale.ok, false);
  const current = await client.observe({ state, token });
  assert.equal(current.state.payload["moveCount"], 1);
});

test("isTerminal：playing 无动作不是正常终局", async () => {
  const client = adapter();
  const { state } = await client.open({ seed: 18 });
  assert.equal(client.isTerminal({ state: { ...state, legalActions: [] } }), false);
});

test("HTTP 错误体、损坏 JSON 和 token 不回显凭证", async () => {
  const original = globalThis.fetch;
  try {
    for (const [body, status] of [
      ["SECRET-TOKEN", 500],
      ["{SECRET-TOKEN", 200],
    ] as const) {
      globalThis.fetch = async () => new Response(body, { status });
      await assert.rejects(adapter().open({ seed: 1 }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes("SECRET-TOKEN"));
        return true;
      });
    }
  } finally {
    globalThis.fetch = original;
  }
  await assert.rejects(adapter().resume({ token: "{SECRET-TOKEN" }), /凭证格式无效/);
});

test("act：没有版本戳缓存时显式抛错，不静默跳过并发校验", async () => {
  const source = adapter();
  const { state, token } = await source.open({ seed: 1 });
  const action = state.legalActions[0]!;

  // 新实例从未 open / resume / observe，缓存为空。
  const fresh = adapter();
  await assert.rejects(
    fresh.act({ state, token, action }),
    /缺少局面的版本戳缓存：act 前必须先 open \/ resume \/ observe/,
  );
});

test("act：observe 填充缓存后可正常落子", async () => {
  const source = adapter();
  const { state, token } = await source.open({ seed: 2 });

  const fresh = adapter();
  const observed = await fresh.observe({ state, token });
  const action = observed.state.legalActions[0]!;
  const result = await fresh.act({ state: observed.state, token, action });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.observation?.state.payload["moveCount"], 1);
  assert.equal(result.observation?.state.turn, "white");
});

test("act：resume 填充缓存后可正常落子", async () => {
  const source = adapter();
  const { token } = await source.open({ seed: 3 });

  const fresh = adapter();
  const resumed = await fresh.resume({ token });
  assert.ok(resumed);

  const action = resumed.state.legalActions[0]!;
  const result = await fresh.act({ state: resumed.state, token, action });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.observation?.state.payload["moveCount"], 1);
  assert.equal(result.observation?.state.turn, "white");
});
