import assert from "node:assert/strict";
import { after, test } from "node:test";

import { OthelloLocalAdapter } from "../src/adapter/othello-local.js";
import { startOthelloStubServer } from "./helpers/othello-stub-server.js";

const stub = await startOthelloStubServer();
after(async () => {
  await stub.close();
});

function adapter(): OthelloLocalAdapter {
  return new OthelloLocalAdapter({ baseUrl: stub.baseUrl, timeoutMs: 5000 });
}

test("act：没有版本戳缓存时显式抛错，不静默跳过并发校验", async () => {
  const source = adapter();
  const { state, token } = await source.open({ seed: 1 });
  const action = state.legalActions[0]!;

  // 新实例从未 open / resume / observe，缓存为空。
  const fresh = adapter();
  await assert.rejects(
    fresh.act({ state, token, action }),
    /缺少房间 .* 的版本戳缓存：act 前必须先 open \/ resume \/ observe/,
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
