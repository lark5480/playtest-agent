import assert from "node:assert/strict";
import { test } from "node:test";
import { diffReports, renderDiffMarkdown } from "../src/core/report-diff.js";
import { buildReportJson } from "../src/core/report-core.js";
import {
  params,
  metadata,
  faultyReport,
  step,
  opening,
  afterMove,
  chessReport,
} from "./helpers/report-fixtures.js";

function healthyReport() {
  return buildReportJson(
    params({
      metadata: { ...metadata, targetVersion: "fixture-v2", source: "healthy-fixture" },
      stopReason: "recording-exhausted",
    }),
  );
}
test("相同记录跨会话可比，同输入diff纯函数", () => {
  const before = buildReportJson(params());
  const after = buildReportJson(
    params({ session: "s2", businessKey: "room2", startedAt: 10, finishedAt: 20 }),
  );
  const diff = diffReports(before, after);
  assert.equal(diff.comparable, true);
  assert.equal(diff.firstDivergence, null);
  assert.deepEqual(diff.addedFindings, []);
  assert.deepEqual(diff.removedFindings, []);
  assert.match(diff.conclusion, /序列一致/);
  assert.equal(renderDiffMarkdown(diff), renderDiffMarkdown(diffReports(before, after)));
});
test("版本为明确变量；健康首错只验证同动作前缀，不宣称全面修复", () => {
  const diff = diffReports(faultyReport(), healthyReport());
  assert.equal(diff.comparable, true);
  assert.equal(diff.firstDivergence, 0);
  assert.deepEqual(diff.removedFindings, ["OTH2-board-projection-mismatch"]);
  assert.match(diff.conclusion, /明确对照变量/);
  assert.match(diff.conclusion, /观察值满足已记录 Oracle 预期/);
  assert.match(diff.conclusion, /仅验证该前缀/);
  assert.match(diff.conclusion, /不代表整局或全面修复/);
});
test("unknown版本降低结论，不能把发现消失称为修复", () => {
  const after = buildReportJson(params({ metadata: { ...metadata, targetVersion: "unknown" } }));
  const diff = diffReports(faultyReport(), after);
  assert.equal(diff.comparable, false);
  assert.match(diff.reasons.join(" "), /unknown/);
  assert.match(diff.conclusion, /不代表已修复/);
});
for (const key of [
  "adapter",
  "oracle",
  "strategy",
  "agentVersion",
  "promptVersion",
  "target",
  "maxSteps",
] as const) {
  test(`对比条件：${key}不同不可比`, () => {
    const changed = { ...metadata, [key]: key === "maxSteps" ? 10 : "different" };
    const diff = diffReports(
      buildReportJson(params()),
      buildReportJson(params({ metadata: changed })),
    );
    assert.equal(diff.comparable, false);
    assert.ok(diff.reasons.some((reason) => reason.includes(key)));
  });
}
test("游戏、初局、seed、预算、治理来源都需要一致", () => {
  const before = buildReportJson(params());
  assert.equal(diffReports(before, chessReport()).comparable, false);
  assert.equal(diffReports(before, buildReportJson(params({ seed: 43 }))).comparable, false);
  assert.equal(
    diffReports(before, buildReportJson(params({ governanceSource: "aiwarden-http" }))).comparable,
    false,
  );
  assert.equal(
    diffReports(before, buildReportJson(params({ budget: { maxCalls: 1, attempts: [] } })))
      .comparable,
    false,
  );
  const initialState = opening();
  (initialState.payload["board"] as number[][])[0]![0] = 1;
  const changed = buildReportJson(
    params({
      initialState,
      steps: [step({ observation: { state: initialState, seq: 0, at: 1 } })],
    }),
  );
  assert.equal(diffReports(before, changed).comparable, false);
});
test("不同LLM动作路径不能冒充同序列回归", () => {
  const llmMetadata = { ...metadata, strategy: "llm-explore", promptVersion: "prompt-v1" };
  const before = buildReportJson(params({ metadata: llmMetadata }));
  const after = buildReportJson(
    params({
      metadata: llmMetadata,
      steps: [step({ action: { id: "3,2", payload: { row: 3, col: 2 } } })],
    }),
  );
  const diff = diffReports(before, after);
  assert.equal(diff.comparable, false);
  assert.equal(diff.firstDivergence, 0);
  assert.match(diff.reasons.join(" "), /动作路径不同/);
});
test("LLM提示版本unknown与降级不能作为同策略证据", () => {
  const report = buildReportJson(params({ metadata: { ...metadata, strategy: "llm" } }));
  assert.equal(diffReports(report, report).comparable, false);
  const degraded = buildReportJson(params({ steps: [step({ degraded: true })] }));
  assert.equal(diffReports(degraded, degraded).comparable, false);
});
test("后报告未到首错、执行失败或缺证据，不称修复", () => {
  const before = faultyReport();
  const empty = buildReportJson(
    params({ steps: [], finalState: opening(), stopReason: "recording-exhausted" }),
  );
  assert.match(diffReports(before, empty).conclusion, /结论不足/);
  const failed = buildReportJson(
    params({
      steps: [step({ outcome: "failed", observationAfter: null })],
      finalState: opening(),
      stopReason: "execution-failed",
    }),
  );
  assert.match(diffReports(before, failed).conclusion, /结论不足/);
  const missing = JSON.parse(JSON.stringify(before));
  delete missing.findings[0].evidence;
  assert.match(diffReports(missing, healthyReport()).conclusion, /缺少一致的 Oracle 预期证据/);
});
test("目标消失但实际仍不满足原Oracle预期，不能当健康", () => {
  const state = afterMove(true);
  const after = buildReportJson(
    params({ finalState: state, steps: [step({ observationAfter: { state, seq: 1, at: 2 } })] }),
  );
  assert.match(diffReports(faultyReport(), after).conclusion, /结论不足/);
});
test("发现稳定按code增减，已有违规不因步号变化假称修好", () => {
  const before = faultyReport();
  const stillBroken = JSON.parse(JSON.stringify(before));
  stillBroken.findings[0].stepNo = null;
  assert.match(diffReports(before, stillBroken).conclusion, /仍有记录/);
  const added = buildReportJson(
    params({ findings: [{ code: "NEW", severity: "warning", message: "新发现", stepNo: 0 }] }),
  );
  const diff = diffReports(before, added);
  assert.deepEqual(diff.addedFindings, ["NEW"]);
  assert.deepEqual(diff.removedFindings, ["OTH2-board-projection-mismatch"]);
});
test("diff Markdown转义全部动态文本", () => {
  const md = renderDiffMarkdown({
    comparable: false,
    reasons: ["<script>|`"],
    addedFindings: ["<x>"],
    removedFindings: [],
    firstDivergence: 0,
    conclusion: "<img onerror=x>",
  });
  assert.ok(!md.includes("<script>"));
  assert.ok(!md.includes("<img"));
  assert.match(md, /&lt;/);
  assert.match(md, /&#124;/);
});
