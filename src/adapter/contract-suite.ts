/**
 * 适配器契约测试套件（地基冻结契约 ④ 的验收装置）
 *
 * 任何适配器接入本项目，**必须**通过本套件导出的全部用例。
 *
 * 这套件的价值：适配器是"游戏专属"的代码，最容易出现"在自己仓库里测得好好的、
 * 接进 Agent 就挂"的情况。契约套件把"接进 Agent 后应该是什么样"固化下来。
 *
 * 用法（在适配器自己的测试里）：
 * ```ts
 * import { adapterContract } from "../../src/adapter/contract-suite.js";
 * const suite = adapterContract(() => new OthelloLocalAdapter({ baseUrl }));
 * suite.forEach((t) => t("契约", t.fn));
 * ```
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Action } from "../types/game.js";
import { canonicalize } from "../core/fingerprint.js";

import type { GameAdapter } from "./game-adapter.js";

/**
 * 一条契约用例。
 */
export interface ContractCase {
  readonly name: string;
  readonly fn: () => Promise<void>;
}

/**
 * 生成适配器契约用例。
 *
 * @param create 适配器工厂（每次调用产生新实例，避免用例间串状态）
 */
export function adapterContract(create: () => GameAdapter): readonly ContractCase[] {
  return [
    {
      name: "open 返回可观察的初始状态",
      fn: async () => {
        const adapter = create();
        const { state } = await adapter.open({ seed: 1 });
        assert.ok(state.id, "状态必须有 id");
        assert.ok(state.status, "状态必须有 status");
      },
    },
    {
      name: "observe 返回的观察序号单调递增",
      fn: async () => {
        const adapter = create();
        const { state, token } = await adapter.open({ seed: 1 });
        const first = await adapter.observe({ state, token });
        const second = await adapter.observe({ state, token });
        assert.ok(
          second.seq >= first.seq,
          `观察序号应单调不减：first=${first.seq} second=${second.seq}`,
        );
      },
    },
    {
      name: "合法动作集非空时每个动作都有稳定 id 与 payload",
      fn: async () => {
        const adapter = create();
        const { state, token } = await adapter.open({ seed: 1 });
        const observation = await adapter.observe({ state, token });
        const seen = new Set<string>();
        for (const action of observation.state.legalActions) {
          assert.ok(action.id, "动作必须有 id");
          assert.ok(action.payload !== undefined, "动作必须有 payload");
          assert.ok(!seen.has(action.id), `动作 id 重复：${action.id}`);
          seen.add(action.id);
        }
      },
    },
    {
      name: "同 seed 开两局，初始状态一致（确定性）",
      fn: async () => {
        const a = await create().open({ seed: 42 });
        const b = await create().open({ seed: 42 });
        assert.deepEqual(
          canonicalize(a.state.payload),
          canonicalize(b.state.payload),
          "同 seed 的初始 payload 应一致",
        );
        assert.equal(a.state.turn, b.state.turn, "同 seed 的初始执子方应一致");
      },
    },
    {
      name: "执行一个合法动作后局面发生变化",
      fn: async () => {
        const adapter = create();
        const { state, token } = await adapter.open({ seed: 7 });
        const observation = await adapter.observe({ state, token });
        const action = observation.state.legalActions[0];
        if (!action) return; // 无合法动作的终局，跳过
        const result = await adapter.act({ state, token, action });
        assert.ok(result.ok, `合法动作应执行成功：${result.error ?? ""}`);
        assert.ok(result.observation, "执行成功必须有后置观察");
        assert.notDeepEqual(
          canonicalize(result.observation.state.payload),
          canonicalize(observation.state.payload),
          "执行合法动作后局面应发生变化",
        );
      },
    },
    {
      name: "执行非法动作被拒绝且不改变局面",
      fn: async () => {
        const adapter = create();
        const { state, token } = await adapter.open({ seed: 7 });
        const observation = await adapter.observe({ state, token });
        const bogus: Action = { id: "__bogus__", payload: { __bogus__: true } };
        const result = await adapter.act({ state, token, action: bogus });
        assert.equal(result.ok, false, "非法动作应被拒绝");
        const after = await adapter.observe({ state, token });
        assert.deepEqual(
          canonicalize(after.state.payload),
          canonicalize(observation.state.payload),
          "非法动作不得改变局面",
        );
      },
    },
    {
      name: "isTerminal 与状态自洽",
      fn: async () => {
        const adapter = create();
        const { state } = await adapter.open({ seed: 7 });
        const terminal = adapter.isTerminal({ state });
        if (terminal) {
          assert.equal(state.status, "finished", "status=finished 才算终局");
        } else {
          assert.notEqual(state.status, "finished", "非终局不应标记 finished");
        }
      },
    },
  ];
}

/**
 * 以 node:test 的形式注册整套契约用例。
 */
export function registerAdapterContract(create: () => GameAdapter, suiteName = "适配器契约"): void {
  for (const c of adapterContract(create)) {
    test(`${suiteName} · ${c.name}`, async () => {
      await c.fn();
    });
  }
}
