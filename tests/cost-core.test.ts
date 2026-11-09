/**
 * 单测 · 成本合并（裁决 25）
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeUsageIntoSteps } from "../src/core/cost-core.js";
import type { GovernanceUsage } from "../src/types/governance.js";
import type { StepRecord } from "../src/types/step.js";

function step(stepNo: number, tokens?: number): StepRecord {
  return {
    stepNo,
    fingerprint: {
      businessKey: "room1",
      session: "s1",
      stepNo,
      digest: "0123456789abcdef0123456789abcdef",
    },
    observation: {
      state: { id: "room1", status: "playing", turn: "black", legalActions: [], payload: {} },
      seq: stepNo,
      at: 1,
    },
    action: { id: `m${stepNo}`, payload: { row: 1 } },
    reason: "ok",
    degraded: false,
    outcome: "applied",
    observationAfter: null,
    governance: { replayed: false, elapsedMs: 1, ...(tokens !== undefined ? { tokens } : {}) },
    elapsedMs: 1,
  };
}

test("治理用量按 stepNo 合并，tokens = prompt + completion", () => {
  const usage: GovernanceUsage = {
    source: "governance-usage",
    byStep: [
      { stepNo: 0, promptTokens: 100, completionTokens: 5, tool: "create_ticket" },
      { stepNo: 1, promptTokens: 100, completionTokens: 0, tool: "create_ticket" },
    ],
  };
  const merged = mergeUsageIntoSteps([step(0), step(1)], usage);
  assert.equal(merged[0]?.governance.tokens, 105);
  assert.equal(merged[1]?.governance.tokens, 100);
  assert.equal(merged[0]?.governance.tokenSource, "governance-usage");
  assert.equal(merged[0]?.governance.tokensUnavailableReason, undefined);
});

test("查询整体不可用：缺成本的步标 unavailable 并写原因，已有成本不被覆盖", () => {
  const usage: GovernanceUsage = {
    source: "unavailable",
    byStep: [],
    unavailableReason: "usage-source-unavailable",
  };
  const merged = mergeUsageIntoSteps([step(0), step(1, 10)], usage);
  assert.equal(merged[0]?.governance.tokens, undefined);
  assert.equal(merged[0]?.governance.tokenSource, "unavailable");
  assert.equal(merged[0]?.governance.tokensUnavailableReason, "usage-source-unavailable");
  assert.equal(merged[1]?.governance.tokens, 10);
  assert.equal(merged[1]?.governance.tokenSource, undefined);
});

test("部分步缺失：只标缺失步，不把整局一概而论", () => {
  const usage: GovernanceUsage = {
    source: "governance-usage",
    byStep: [{ stepNo: 0, promptTokens: 3, completionTokens: 1, tool: "t" }],
  };
  const merged = mergeUsageIntoSteps([step(0), step(1)], usage);
  assert.equal(merged[0]?.governance.tokens, 4);
  assert.equal(merged[1]?.governance.tokens, undefined);
  assert.equal(merged[1]?.governance.tokenSource, "unavailable");
  assert.equal(merged[1]?.governance.tokensUnavailableReason, "no-step-record");
});
