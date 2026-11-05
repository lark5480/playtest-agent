/**
 * 单测 · HTML 报告渲染
 *
 * 目标：浏览器可直接打开（无 ServiceWorker / 无脚本），且动态文本必须转义。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildReportJson } from "../src/core/report-core.js";
import { renderReportHtml } from "../src/report/report-html.js";
import type { StepRecord } from "../src/types/step.js";

function step(): StepRecord {
  return {
    stepNo: 0,
    fingerprint: {
      businessKey: "room1",
      session: "s1",
      stepNo: 0,
      digest: "0123456789abcdef0123456789abcdef",
    },
    observation: {
      state: { id: "room1", status: "playing", turn: "black", legalActions: [], payload: {} },
      seq: 0,
      at: 1,
    },
    action: { id: "2,3", payload: { row: 2, col: 3 } },
    reason: "ok",
    degraded: false,
    llmTokens: 12,
    model: "test-model",
    outcome: "applied",
    observationAfter: null,
    governance: {
      replayed: false,
      elapsedMs: 3,
      traceId: "trace-abc",
      tokens: 100,
      tokenSource: "governance-usage",
    },
    elapsedMs: 3,
  };
}

test("HTML 报告自包含、包含治理证据且转义动态文本", () => {
  const report = buildReportJson({
    scenario: "smoke",
    session: "s1",
    businessKey: "room1",
    seed: 42,
    startedAt: 1,
    finishedAt: 2,
    steps: [step()],
    findings: [
      {
        code: "F1",
        severity: "fatal",
        message: "<script>alert(1)</script>",
        stepNo: 0,
      },
    ],
    governanceSource: "aiwarden-http",
  });

  const html = renderReportHtml(report);
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("治理证据"));
  assert.ok(html.includes("status-failed"));
  assert.ok(html.includes("llm:12"));
  assert.ok(html.includes("gov:100"));
  assert.ok(html.includes("trace-abc"));
  assert.ok(!html.includes("<script>alert(1)</script>"), "动态文本不得原样注入");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
});
