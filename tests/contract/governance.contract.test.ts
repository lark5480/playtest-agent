/**
 * 治理契约测试 · 内存替身
 *
 * 用契约套件校验内存替身的行为（幂等、重放不重复副作用、成本口径一致）。
 * 真实 aiwarden 的 HTTP 实现必须跑同一套件 —— 见 tests/integration/。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AiwardenHttpClient } from "../../src/governance/aiwarden-client.js";
import { InMemoryGovernanceClient } from "../../src/governance/client.js";

import { registerGovernanceContract } from "./governance.contract.js";

registerGovernanceContract(() => new InMemoryGovernanceClient());

for (const status of ["FAILED", "PENDING_APPROVAL", "PENDING", "REJECTED", "unknown", undefined]) {
  for (const replayed of [false, true]) {
    test(`HTTP 治理 ${String(status)} × replayed=${replayed} 拒绝执行且不泄露错误体`, async (t) => {
      t.mock.method(
        globalThis,
        "fetch",
        async () =>
          new Response(
            JSON.stringify({
              status,
              replayed,
              error: "SECRET-TOKEN",
            }),
          ),
      );
      const client = new AiwardenHttpClient();
      let count = 0;
      await assert.rejects(
        client.invoke({
          businessKey: "room",
          session: "run",
          stepNo: 0,
          action: {},
          perform: async () => {
            count += 1;
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(!error.message.includes("SECRET-TOKEN"));
          return true;
        },
      );
      assert.equal(count, 0);
    });
  }
}
