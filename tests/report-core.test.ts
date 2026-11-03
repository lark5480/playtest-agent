/**
 * 单测 · 报告核心（地基冻结契约 ⑧）
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildReportJson, renderReportMarkdown } from "../src/core/report-core.js";
import type { StepRecord } from "../src/types/step.js";

function step(over: Partial<StepRecord> = {}): StepRecord {
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
    action: { id: "m1", payload: { row: 1 } },
    reason: "ok",
    degraded: false,
    outcome: "applied",
    observationAfter: null,
    governance: { replayed: false, elapsedMs: 3 },
    elapsedMs: 3,
    ...over,
  };
}

const base = {
  scenario: "smoke",
  session: "s1",
  businessKey: "room1",
  seed: 42,
  startedAt: 1,
  finishedAt: 2,
};

test("无发现且末步成功 → passed", () => {
  const report = buildReportJson({ ...base, steps: [step()], findings: [] });
  assert.equal(report.status, "passed");
  assert.equal(report.stepCount, 1);
});

test("有 fatal 发现 → failed", () => {
  const report = buildReportJson({
    ...base,
    steps: [step()],
    findings: [{ code: "F1", severity: "fatal", message: "坏了", stepNo: 0 }],
  });
  assert.equal(report.status, "failed");
  assert.equal(report.findings.length, 1);
});

test("只有 warning → passed（记录但不中断）", () => {
  const report = buildReportJson({
    ...base,
    steps: [step()],
    findings: [{ code: "W1", severity: "warning", message: "可疑", stepNo: 0 }],
  });
  assert.equal(report.status, "passed");
});

test("末步失败 → incomplete", () => {
  const report = buildReportJson({
    ...base,
    steps: [step({ outcome: "failed" })],
    findings: [],
  });
  assert.equal(report.status, "incomplete");
});

test("统计降级步 / 重放步 / 失败步", () => {
  const report = buildReportJson({
    ...base,
    steps: [
      step({ degraded: true }),
      step({ stepNo: 1, governance: { replayed: true, elapsedMs: 1 } }),
      step({ stepNo: 2, outcome: "failed" }),
    ],
    findings: [],
  });
  assert.equal(report.degradedSteps, 1);
  assert.equal(report.replayedSteps, 1);
  assert.equal(report.failedSteps, 1);
});

test("JSON 结构冻结：schemaVersion 恒为 1", () => {
  const report = buildReportJson({ ...base, steps: [], findings: [] });
  assert.equal(report.schemaVersion, 1);
});

test("Markdown 渲染含状态、发现表与步骤表", () => {
  const report = buildReportJson({
    ...base,
    steps: [step()],
    findings: [{ code: "F1", severity: "fatal", message: "坏消息", stepNo: 0 }],
  });
  const md = renderReportMarkdown(report);
  assert.ok(md.includes("Playtest 报告"));
  assert.ok(md.includes("failed"));
  assert.ok(md.includes("| F1 |"));
  assert.ok(md.includes("| 0 |"));
});

test("Markdown 渲染是纯函数（同输入同输出）", () => {
  const report = buildReportJson({ ...base, steps: [step()], findings: [] });
  assert.equal(renderReportMarkdown(report), renderReportMarkdown(report));
});
