/**
 * 治理契约测试套件（地基冻结契约 ⑦ 的验收装置）
 *
 * 任何 GovernanceClient 实现都必须通过本套件。
 *
 * **为什么这条最重要**：本项目用内存替身做大部分测试，用真实 aiwarden 做集成测试。
 * 若替身与真实实现行为不一致，就会出现"单测全绿但真实链路是坏的"——
 * 这正是 aiwarden AGENTS §4 点名的坑形态（**不报错、只是静默不生效**）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { GovernanceClient } from "../../src/types/governance.js";
export interface GovernanceContractCase {
  readonly name: string;
  readonly fn: (client: GovernanceClient) => Promise<void>;
}

export function governanceContract(): readonly GovernanceContractCase[] {
  return [
    {
      name: "首次调用执行副作用且 replayed=false",
      fn: async (client) => {
        let performed = 0;
        const result = await client.invoke({
          businessKey: "room1",
          session: "s1",
          stepNo: 0,
          action: { row: 1 },
          perform: async () => {
            performed += 1;
          },
        });
        assert.equal(performed, 1, "首次调用必须执行副作用");
        assert.equal(result.replayed, false);
      },
    },
    {
      name: "同键重放不产生第二次副作用（幂等）",
      fn: async (client) => {
        let performed = 0;
        const call = () =>
          client.invoke({
            businessKey: "room1",
            session: "s1",
            stepNo: 0,
            action: { row: 1 },
            perform: async () => {
              performed += 1;
            },
          });
        await call();
        const second = await call();
        assert.equal(performed, 1, "重放不得产生第二次副作用");
        assert.equal(second.replayed, true, "重放必须标记 replayed=true");
      },
    },
    {
      name: "不同步号不互相命中（键含 stepNo）",
      fn: async (client) => {
        let performed = 0;
        for (const stepNo of [0, 1]) {
          await client.invoke({
            businessKey: "room1",
            session: "s1",
            stepNo,
            action: { row: 1 },
            perform: async () => {
              performed += 1;
            },
          });
        }
        assert.equal(performed, 2, "不同步号是不同动作，必须各自执行");
      },
    },
    {
      name: "不同 session 不互相命中",
      fn: async (client) => {
        let performed = 0;
        for (const session of ["s1", "s2"]) {
          await client.invoke({
            businessKey: "room1",
            session,
            stepNo: 0,
            action: { row: 1 },
            perform: async () => {
              performed += 1;
            },
          });
        }
        assert.equal(performed, 2, "不同 session 必须各自执行");
      },
    },
    {
      name: "同一步不同动作不互相命中（键含动作内容）",
      fn: async (client) => {
        let performed = 0;
        for (const action of [{ row: 1 }, { row: 2 }]) {
          await client.invoke({
            businessKey: "room1",
            session: "s1",
            stepNo: 0,
            action,
            perform: async () => {
              performed += 1;
            },
          });
        }
        assert.equal(performed, 2, "同一步的不同动作必须各自执行（否则会漏动作）");
      },
    },
    {
      name: "动作内容键序不同视为同一动作",
      fn: async (client) => {
        let performed = 0;
        for (const action of [
          { row: 1, col: 2 },
          { col: 2, row: 1 },
        ]) {
          await client.invoke({
            businessKey: "room1",
            session: "s1",
            stepNo: 0,
            action,
            perform: async () => {
              performed += 1;
            },
          });
        }
        assert.equal(performed, 1, "语义相同的动作必须命中同一键");
      },
    },
    {
      name: "返回 traceId（用于与治理侧 trace 串联）",
      fn: async (client) => {
        const result = await client.invoke({
          businessKey: "room1",
          session: "s1",
          stepNo: 0,
          action: { row: 1 },
          perform: async () => {},
        });
        assert.ok(result.traceId, "必须返回 traceId，否则无法与治理侧串联");
      },
    },
    {
      name: "重放返回的 tokens 与首次一致（成本归因不重复计入）",
      fn: async (client) => {
        const call = () =>
          client.invoke({
            businessKey: "room1",
            session: "s1",
            stepNo: 0,
            action: { row: 1 },
            perform: async () => {},
          });
        const first = await call();
        const second = await call();
        assert.equal(second.tokens, first.tokens, "重放的 token 口径应与首次一致");
      },
    },
  ];
}

export function registerGovernanceContract(
  create: () => GovernanceClient,
  suiteName = "治理契约",
): void {
  for (const c of governanceContract()) {
    test(`${suiteName} · ${c.name}`, async () => {
      await c.fn(create());
    });
  }
}
