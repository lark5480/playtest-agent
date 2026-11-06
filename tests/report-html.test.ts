import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReportJson } from "../src/core/report-core.js";
import { renderReportHtml } from "../src/report/report-html.js";
import {
  params,
  step,
  faultyReport,
  chessReport,
  opening,
  finished,
} from "./helpers/report-fixtures.js";

test("HTML v2 自包含无JS无外链；所有动态标记转义", () => {
  const report = buildReportJson(
    params({
      scenario: '<script>alert("x")</script><img src=x onerror=alert(1)>',
      steps: [
        step({
          llmTokens: 12,
          governance: {
            replayed: false,
            elapsedMs: 3,
            traceId: "trace-abc",
            tokens: 100,
            tokenSource: "governance-usage",
          },
        }),
      ],
      governanceSource: "aiwarden-http",
    }),
  );
  const html = renderReportHtml(report);
  assert.ok(html.startsWith("<!doctype html>"));
  assert.match(html, /治理证据/);
  assert.match(html, /llm:12/);
  assert.match(html, /gov:100/);
  assert.match(html, /trace-abc/);
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes("<img"));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&quot;x&quot;/);
  assert.ok(!html.includes("tokens 合计"));
  assert.match(html, /Content-Security-Policy/);
  assert.ok(!/\s(?:href|src)="(?:https?:|javascript:)/i.test(html));
  assert.equal(html, renderReportHtml(report));
});
test("首错before棋盘优先，独立Oracle预期/实际和错格清楚可定位", () => {
  const html = renderReportHtml(faultyReport());
  assert.match(html, /首错前态 before/);
  assert.match(html, /Oracle 差异格/);
  assert.match(html, /3,3: 白，Oracle 差异格/);
  assert.match(html, /<td class="mismatch"/);
  assert.match(html, /board\[3\]\[3\]/);
  assert.match(html, /<th>预期<\/th><th>实际<\/th>/);
  assert.match(html, /<pre>1<\/pre>.*<pre>2<\/pre>/);
  assert.match(html, /id="step-0"/);
  assert.match(html, /href="#step-0"/);
  assert.match(html, /assertion-failed/);
  assert.match(html, /injected-fixture/);
  assert.ok(html.indexOf("首错前态 before") < html.indexOf("<h2>运行条件"));
});
test("窄屏使用横向滚动表格，不截断步骤", () => {
  const html = renderReportHtml(faultyReport());
  assert.match(html, /name="viewport"/);
  assert.match(html, /overflow-x:auto/);
  assert.match(html, /@media\(max-width:600px\)/);
  assert.match(html, /class="table-scroll" tabindex="0"/);
});
test("chess只展示真实FEN、SAN、历史与结果，不伪造棋盘", () => {
  const html = renderReportHtml(chessReport());
  assert.match(html, /FEN/);
  assert.match(html, /fenHistory/);
  assert.match(html, /e2e4/);
  assert.match(html, /e4/);
  assert.ok(!html.includes('<table class="board"'));
});
test("warning、截断、无发现、缺usage、降级都有明确展示", () => {
  const report = buildReportJson(
    params({
      steps: [step({ degraded: true, degradedReason: "SECRET_MODEL_ERROR" })],
      findings: [{ code: "W1", message: "SECRET_RAW_RESPONSE", severity: "warning", stepNo: 0 }],
    }),
  );
  const html = renderReportHtml(report);
  assert.match(html, /status-incomplete/);
  assert.match(html, /step-limit/);
  assert.match(html, /severity-warning/);
  assert.match(html, /unknown/);
  assert.match(html, /已降级到确定性基线/);
  assert.ok(!html.includes("SECRET"));
  assert.match(renderReportHtml(buildReportJson(params())), /无 fatal 发现/);
});
test("预算账目展示无动作的未知尝试和已知越过量", () => {
  const html = renderReportHtml(
    buildReportJson(
      params({
        steps: [],
        initialState: opening(),
        finalState: opening(),
        stopReason: "budget-limit",
        budget: {
          maxCalls: 3,
          tokenLimit: 20,
          attempts: [
            { callId: 1, state: "settled", tokens: 25 },
            { callId: 2, state: "unknown" },
          ],
        },
      }),
    ),
  );
  assert.match(html, /已预扣调用 2 \/ 3/);
  assert.match(html, /已知越过量 5/);
  assert.match(html, /unknown/);
  assert.match(html, /budget-limit/);
});
test("零步完整终局与无evidence不补造预期", () => {
  const state = finished();
  const html = renderReportHtml(
    buildReportJson(
      params({
        steps: [],
        initialState: state,
        finalState: state,
        stopReason: "game-finished",
        gameTerminal: true,
      }),
    ),
  );
  assert.match(html, /status-passed/);
  assert.match(html, /game-finished/);
  const warning = buildReportJson(
    params({ findings: [{ code: "W1", severity: "warning", message: "警告", stepNo: 0 }] }),
  );
  assert.match(renderReportHtml(warning), /没有结构化 Oracle 证据/);
});
test("HTML拒绝v1、缺usage及不一致状态，不用默认0补造", () => {
  const raw = JSON.parse(JSON.stringify(buildReportJson(params())));
  delete raw.usage;
  assert.throws(() => renderReportHtml(raw), /usage/);
  raw.schemaVersion = 1;
  assert.throws(() => renderReportHtml(raw), /不支持报告 v1/);
});
