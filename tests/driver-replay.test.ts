/**
 * 单测 · 驱动重放语义（P1-4）
 *
 * 两条关键路径：
 * 1. 治理报告重放、游戏状态已是执行后 → outcome=replayed，不重复执行；
 * 2. 治理报告重放、游戏状态仍是执行前 → 不能静默跳过，必须补偿执行并记 warning。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { GameAdapter } from "../src/adapter/game-adapter.js";
import { drive } from "../src/driver/game-driver.js";
import { GenericOracle } from "../src/oracle/generic.js";
import type { Strategy } from "../src/strategy/strategy.js";
import type { Action, GameState, Observation } from "../src/types/game.js";
import type { GovernanceClient, GovernanceResult } from "../src/types/governance.js";

const ACTION: Action = { id: "a", payload: { row: 0 } };
const S0: GameState = {
  id: "room1",
  status: "playing",
  turn: "black",
  legalActions: [ACTION],
  payload: { moveCount: 0 },
};
const S1: GameState = {
  id: "room1",
  status: "finished",
  turn: null,
  legalActions: [],
  payload: { moveCount: 1 },
};

class ScriptedAdapter implements GameAdapter {
  readonly name = "scripted";
  public applied = false;
  public actCount = 0;

  async open(): Promise<{ state: GameState; token: string }> {
    return { state: S0, token: "t" };
  }

  async observe(): Promise<Observation> {
    return { state: this.applied ? S1 : S0, seq: this.applied ? 1 : 0, at: 1 };
  }

  async act(): Promise<{ ok: boolean; observation?: Observation }> {
    this.actCount += 1;
    this.applied = true;
    return { ok: true, observation: { state: S1, seq: 1, at: 1 } };
  }

  isTerminal(params: { state: GameState }): boolean {
    return params.state.status === "finished";
  }
}

class ReplayGovernance implements GovernanceClient {
  readonly name = "replay-fake";

  constructor(private readonly replayed: boolean) {}

  async invoke(params: {
    readonly businessKey: string;
    readonly session: string;
    readonly stepNo: number;
    readonly action: Readonly<Record<string, unknown>>;
    readonly perform: () => Promise<void>;
  }): Promise<GovernanceResult> {
    if (!this.replayed) await params.perform();
    return { businessKey: params.businessKey, replayed: this.replayed };
  }
}

const strategy: Strategy = {
  name: "first",
  async decide({ observation }) {
    const action = observation.state.legalActions[0] ?? null;
    return { action, reason: "first", degraded: false };
  },
};

test("治理重放 + 游戏已是执行后 → outcome=replayed，不重复调用 act", async () => {
  const adapter = new ScriptedAdapter();
  adapter.applied = true; // 动作此前已经生效
  const result = await drive({
    adapter,
    strategy,
    oracle: new GenericOracle(),
    governance: new ReplayGovernance(true),
    scenario: "replay",
    seed: 1,
    maxSteps: 2,
  });

  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]?.outcome, "replayed");
  assert.equal(result.steps[0]?.governance.replayed, true);
  assert.equal(adapter.actCount, 0, "重放不得再调用 act");
});

test("治理重放 + 游戏仍是执行前 → 补偿执行并记 G7 warning", async () => {
  const adapter = new ScriptedAdapter(); // applied=false
  const result = await drive({
    adapter,
    strategy,
    oracle: new GenericOracle(),
    governance: new ReplayGovernance(true),
    scenario: "repair",
    seed: 1,
    maxSteps: 2,
  });

  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]?.outcome, "applied");
  assert.equal(adapter.actCount, 1, "状态未变时必须补偿执行游戏动作");
  assert.ok(
    result.findings.some((finding) => finding.code === "G7-governance-replayed-before-game-state"),
    "必须显式记录治理账与游戏状态曾不一致",
  );
});
