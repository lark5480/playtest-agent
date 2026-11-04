/**
 * 集成测试 · 真实 chess-arena
 *
 * 前置：chess-arena 需在 localhost:3000 运行（`npm run dev`）。
 * 不可用则**显式跳过**，不假装通过。
 *
 * 上限 40 步：既要覆盖多种棋型，又要避开 chess-arena 走子接口
 * 60 次/分钟的内存限流。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ChessArenaAdapter } from "../../src/adapter/chess-arena.js";
import { drive } from "../../src/driver/game-driver.js";
import { InMemoryGovernanceClient } from "../../src/governance/client.js";
import { ChessOracle } from "../../src/oracle/chess.js";
import { CompositeOracle } from "../../src/oracle/composite.js";
import { GenericOracle } from "../../src/oracle/generic.js";
import { HeuristicStrategy } from "../../src/strategy/heuristic.js";

const BASE_URL = process.env.CHESS_ARENA_BASE_URL ?? "http://localhost:3000";

async function chessArenaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

const available = await chessArenaAvailable();
const skip = available
  ? false
  : `chess-arena 不可用（先在其仓库执行 npm run dev，地址 ${BASE_URL}）`;

test("真实 chess-arena：能开局、走子并通过通用与象棋断言", { skip }, async () => {
  const result = await drive({
    adapter: new ChessArenaAdapter({ baseUrl: BASE_URL }),
    strategy: new HeuristicStrategy(),
    oracle: new CompositeOracle([new GenericOracle(), new ChessOracle()]),
    governance: new InMemoryGovernanceClient(),
    scenario: "chess-integration",
    seed: 11,
    maxSteps: 40,
  });

  assert.ok(result.steps.length > 0, "应至少走一步");
  assert.equal(
    result.findings.filter((finding) => finding.severity === "fatal").length,
    0,
    "不应出现 fatal 断言失败",
  );
  assert.ok(
    result.steps.every((step) => step.outcome === "applied" || step.outcome === "replayed"),
    "每一步都应成功生效",
  );
});
