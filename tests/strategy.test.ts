/**
 * 单测 · 确定性基线策略
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { HeuristicStrategy } from "../src/strategy/heuristic.js";
import type { GameState, Observation } from "../src/types/game.js";

function observation(over: Partial<GameState> = {}, seq = 0): Observation {
  return {
    state: {
      id: "room1",
      status: "playing",
      turn: "black",
      legalActions: [
        { id: "a", payload: { row: 1 } },
        { id: "b", payload: { row: 2 } },
        { id: "c", payload: { row: 3 } },
      ],
      payload: {},
      ...over,
    },
    seq,
    at: 1,
  };
}

test("同 seed + 同局面 → 同动作", async () => {
  // 策略是**无状态**的：每步只由 (seed, observation.seq) 派生 PRNG。
  // 两个独立实例在同一局面/同一 seq 上必须给出相同动作。
  const a = new HeuristicStrategy();
  const b = new HeuristicStrategy();
  const da = await a.decide({ observation: observation(), seed: 42 });
  const db = await b.decide({ observation: observation(), seed: 42 });
  assert.equal(da.action?.id, db.action?.id);
});

test("策略无状态：新实例从中间 seq 继续 → 与连续运行同一动作", async () => {
  const continuous = new HeuristicStrategy();
  await continuous.decide({ observation: observation({}, 0), seed: 42 });
  await continuous.decide({ observation: observation({}, 1), seed: 42 });
  const expected = await continuous.decide({ observation: observation({}, 2), seed: 42 });

  const fresh = new HeuristicStrategy();
  const actual = await fresh.decide({ observation: observation({}, 2), seed: 42 });
  assert.equal(actual.action?.id, expected.action?.id, "续跑不应因 PRNG 内部状态丢失而换动作");
});

test("异局面 → 可能不同动作（探索性）", async () => {
  const strategy = new HeuristicStrategy();
  const seen = new Set<string | undefined>();
  for (let seq = 0; seq < 30; seq++) {
    const d = await strategy.decide({
      observation: observation(
        {
          legalActions: [
            { id: `a${seq}`, payload: { row: seq } },
            { id: `b${seq}`, payload: { row: seq + 1 } },
          ],
        },
        seq,
      ),
      seed: 42,
    });
    seen.add(d.action?.id);
  }
  assert.ok(seen.size > 1, "不同局面应能选到不同动作（否则探索性为零）");
});

test("无合法动作 → 返回 null 且不抛错", async () => {
  const strategy = new HeuristicStrategy();
  const d = await strategy.decide({ observation: observation({ legalActions: [] }), seed: 1 });
  assert.equal(d.action, null);
  assert.equal(d.degraded, false);
});

test("基线策略不标降级（降级是调用方的判断）", async () => {
  const strategy = new HeuristicStrategy();
  const d = await strategy.decide({ observation: observation(), seed: 1 });
  assert.equal(d.degraded, false);
});

test("动作必落在合法动作集内", async () => {
  const strategy = new HeuristicStrategy();
  const obs = observation();
  const d = await strategy.decide({ observation: obs, seed: 7 });
  assert.ok(obs.state.legalActions.some((a) => a.id === d.action?.id));
});

test("同 seed 的整局动作序列确定（红线 2.4）", async () => {
  // 连续多步：PRNG 必须持续推进，不能每步都取同一个数。
  const seq = async (seed: number): Promise<string[]> => {
    const strategy = new HeuristicStrategy();
    const out: string[] = [];
    for (let i = 0; i < 20; i++) {
      const d = await strategy.decide({ observation: observation({}, i), seed });
      out.push(d.action?.id ?? "-");
    }
    return out;
  };
  const a = await seq(42);
  const b = await seq(42);
  assert.deepEqual(a, b, "同 seed 的动作序列必须完全一致");
  assert.ok(new Set(a).size > 1, "序列应有变化（否则探索性为零）");
});

test("不同 seed 的动作序列不同", async () => {
  const seq = async (seed: number): Promise<string[]> => {
    const strategy = new HeuristicStrategy();
    const out: string[] = [];
    for (let i = 0; i < 20; i++) {
      const d = await strategy.decide({ observation: observation({}, i), seed });
      out.push(d.action?.id ?? "-");
    }
    return out;
  };
  assert.notDeepEqual(await seq(1), await seq(2));
});

test("局面里的房间号不影响动作序列（确定性不被环境污染）", async () => {
  const run = async (roomId: string): Promise<string[]> => {
    const strategy = new HeuristicStrategy();
    const out: string[] = [];
    for (let i = 0; i < 20; i++) {
      const obs = observation({}, i);
      const withRoom = { ...obs, state: { ...obs.state, id: roomId } };
      const d = await strategy.decide({ observation: withRoom, seed: 42 });
      out.push(d.action?.id ?? "-");
    }
    return out;
  };
  assert.deepEqual(await run("ROOM-A"), await run("ROOM-B"), "房间号不得影响动作选择");
});
