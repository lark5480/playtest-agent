import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReportJson, renderReportMarkdown, reportExitCode } from "../src/core/report-core.js";
import { parseReportJson } from "../src/core/recording.js";
import {
  afterMove,
  finished,
  opening,
  params,
  step,
  finding,
  metadata,
} from "./helpers/report-fixtures.js";
import type { StopReason } from "../src/types/run.js";

test("恢复分歧优先分类4；截断不会被旧passed状态覆盖", () => {
  assert.equal(
    reportExitCode(
      buildReportJson(params({ stopReason: "execution-failed", errorCategory: "state" })),
    ),
    4,
  );
  assert.equal(reportExitCode({ ...buildReportJson(params()), status: "passed" }), 5);
});

test("两步有效状态链，模型与治理分源未知不误计为0", () => {
  const before = afterMove();
  const next = afterMove();
  const board = next.payload["board"] as number[][];
  board[2]![2] = 2;
  board[3]![3] = 2;
  const state = {
    ...next,
    turn: "black",
    legalActions: [{ id: "3,2", payload: { row: 3, col: 2 } }],
    payload: { ...next.payload, board, moveCount: 2 },
  };
  const report = buildReportJson(
    params({
      finalState: state,
      steps: [
        step({
          llmTokens: 12,
          governance: {
            replayed: false,
            elapsedMs: 1,
            tokens: 10,
            tokenSource: "governance-usage",
          },
        }),
        step({
          stepNo: 1,
          observation: { state: before, seq: 1, at: 2 },
          action: { id: "2,2", payload: { row: 2, col: 2 } },
          observationAfter: { state, seq: 2, at: 3 },
          governance: { replayed: false, elapsedMs: 1, tokens: 20, tokenSource: "synthetic" },
        }),
      ],
    }),
  );
  assert.equal(report.stepCount, 2);
  assert.equal(report.usage.llm, null);
  assert.equal(report.usage.governance, 10);
  assert.equal(report.usage.synthetic, 20);
  assert.deepEqual(parseReportJson(JSON.parse(JSON.stringify(report))), report);
});

const warning = { code: "W1", severity: "warning" as const, message: "注意", stepNo: 0 };

test("v2：成功动作不等于完整终局；warning 不掩盖步限", () => {
  for (const findings of [[], [warning]]) {
    const report = buildReportJson(params({ findings }));
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.status, "incomplete");
    assert.equal(report.assertionStatus, "passed");
    assert.equal(reportExitCode(report), 5);
    assert.deepEqual(parseReportJson(JSON.parse(JSON.stringify(report))), report);
  }
});
test("最后一步恰好终局优先于步限，只有正确终局 passed", () => {
  const state = finished();
  const before = finished();
  const board = before.payload["board"] as number[][];
  board[0]![0] = 0;
  board[0]![1] = 2;
  const initialState = {
    ...before,
    status: "playing" as const,
    turn: "black",
    legalActions: [{ id: "0,0", payload: { row: 0, col: 0 } }],
    payload: { ...before.payload, moveCount: 59, winner: null },
  };
  const report = buildReportJson(
    params({
      metadata: { ...metadata, maxSteps: 1 },
      initialState,
      finalState: state,
      steps: [
        step({
          observation: { state: initialState, seq: 0, at: 1 },
          action: initialState.legalActions[0]!,
          observationAfter: { state, seq: 1, at: 2 },
        }),
      ],
      stopReason: "game-finished",
      gameTerminal: true,
      findings: [warning],
    }),
  );
  assert.equal(report.status, "passed");
  assert.equal(reportExitCode(report), 0);
});
test("fatal 始终优先，不能把 assertion failure 改成游戏终局", () => {
  const report = buildReportJson(params({ findings: [finding], stopReason: "assertion-failed" }));
  assert.equal(report.status, "failed");
  assert.equal(report.assertionStatus, "failed");
  assert.equal(report.gameTerminal, false);
  assert.equal(reportExitCode(report), 1);
});
test("零步真实终局可报告；零步非终局没有断言证据", () => {
  const state = finished();
  const report = buildReportJson(
    params({
      steps: [],
      initialState: state,
      finalState: state,
      stopReason: "game-finished",
      gameTerminal: true,
    }),
  );
  assert.equal(report.status, "passed");
  const empty = buildReportJson(
    params({ steps: [], initialState: opening(), finalState: opening() }),
  );
  assert.equal(empty.status, "incomplete");
  assert.equal(empty.assertionStatus, "not-evaluated");
});
test("未确认 Oracle / 后态缺失 / 失败动作均不足以判 passed", () => {
  const state = finished();
  const unknown = buildReportJson(
    params({
      metadata: { ...metadata, oracle: "unknown" },
      steps: [],
      initialState: state,
      finalState: state,
      stopReason: "game-finished",
      gameTerminal: true,
    }),
  );
  assert.equal(unknown.status, "incomplete");
  for (const outcome of ["failed", "rejected", "replayed"] as const) {
    const report = buildReportJson(
      params({
        finalState: opening(),
        steps: [step({ outcome, observationAfter: null })],
        findings: [warning],
        stopReason: "execution-failed",
        errorCategory: "game",
      }),
    );
    assert.equal(report.status, "incomplete");
    assert.equal(report.assertionStatus, "not-evaluated");
    assert.equal(reportExitCode(report), 6);
  }
});
for (const [stopReason, exit] of [
  ["budget-limit", 5],
  ["step-limit", 5],
  ["recording-exhausted", 5],
  ["strategy-stopped", 5],
  ["state-diverged", 4],
  ["stalled", 5],
  ["execution-failed", 6],
] as const) {
  test(`停止原因 ${stopReason} 不误报成功，退出 ${exit}`, () => {
    const report = buildReportJson(params({ stopReason: stopReason as StopReason }));
    assert.equal(report.status, "incomplete");
    assert.equal(reportExitCode(report), exit);
  });
}
test("退出码 fatal1 优先于执行6，state4 与 budget5 分类", () => {
  for (const [errorCategory, exit] of [
    ["governance", 6],
    ["game", 6],
    ["strategy", 6],
    ["state", 4],
    ["budget", 5],
  ] as const) {
    assert.equal(reportExitCode(buildReportJson(params({ errorCategory }))), exit);
    assert.equal(
      reportExitCode(buildReportJson(params({ errorCategory, findings: [finding] }))),
      1,
    );
  }
});
test("用量不跨单位相加；真实0与unknown不同", () => {
  const report = buildReportJson(
    params({
      steps: [
        step({
          llmTokens: 12,
          governance: {
            replayed: false,
            elapsedMs: 1,
            traceId: "trace-abc",
            tokens: 10,
            tokenSource: "synthetic",
          },
        }),
      ],
    }),
  );
  assert.equal(report.usage.llm, 12);
  assert.equal(report.usage.governance, null);
  assert.equal(report.usage.synthetic, 10);
  assert.equal("total" in report.usage, false);
  assert.deepEqual(report.usage.sources, ["model-usage", "synthetic"]);
  const real = buildReportJson(
    params({
      steps: [
        step({
          llmTokens: 0,
          governance: { replayed: false, elapsedMs: 1, tokens: 0, tokenSource: "governance-usage" },
        }),
      ],
    }),
  );
  assert.equal(real.usage.llm, 0);
  assert.equal(real.usage.governance, 0);
  const missing = buildReportJson(params());
  assert.equal(missing.usage.llm, null);
  assert.equal(missing.usage.governance, null);
  assert.equal(missing.usage.synthetic, null);
  assert.equal(missing.usage.unavailableSteps, 1);
});
test("预算账目包含未形成动作的调用，不与步骤模型用量双计；unknown不填0", () => {
  const report = buildReportJson(
    params({
      steps: [step({ llmTokens: 12 })],
      budget: {
        maxCalls: 3,
        tokenLimit: 20,
        attempts: [
          { callId: 1, state: "settled", tokens: 12 },
          { callId: 2, state: "settled", tokens: 15 },
        ],
      },
    }),
  );
  assert.equal(report.usage.llm, 27);
  const unknown = buildReportJson(
    params({
      budget: {
        maxCalls: 3,
        attempts: [
          { callId: 1, state: "settled", tokens: 12 },
          { callId: 2, state: "unknown" },
        ],
      },
    }),
  );
  assert.equal(unknown.usage.llm, null);
  assert.ok(unknown.usage.sources.includes("unavailable"));
});
test("统计降级 / 重放 / 失败；原因以闭合码落报告并在 Markdown 展示语义", () => {
  const report = buildReportJson(
    params({
      finalState: opening(),
      steps: [
        step({
          degraded: true,
          degradedReason: "timeout",
          outcome: "failed",
          observationAfter: null,
          error: "game-request-failed",
          governance: {
            replayed: true,
            elapsedMs: 3,
            tokensUnavailableReason: "usage-query-failed",
          },
        }),
      ],
      governanceDegradedReason: "unreachable",
      stopReason: "execution-failed",
    }),
  );
  assert.equal(report.degradedSteps, 1);
  assert.equal(report.replayedSteps, 1);
  assert.equal(report.failedSteps, 1);
  assert.equal(report.steps[0]?.degradedReason, "timeout");
  assert.equal(report.steps[0]?.error, "game-request-failed");
  assert.equal(report.steps[0]?.tokensUnavailableReason, "usage-query-failed");
  assert.equal(report.governanceDegradedReason, "unreachable");
  const md = renderReportMarkdown(report);
  assert.match(md, /模型调用超时/);
  assert.match(md, /game-request-failed/);
  assert.match(md, /治理降级：aiwarden 不可达/);
});
test("不可信原因字段收敛为 unknown，不回显原文或凭证", () => {
  const report = buildReportJson(
    params({
      finalState: opening(),
      steps: [
        step({
          degraded: true,
          degradedReason: "timeout",
          outcome: "failed",
          observationAfter: null,
          error: "game-request-failed",
          governance: {
            replayed: false,
            elapsedMs: 3,
            tokensUnavailableReason: "usage-query-failed",
          },
        }),
      ],
      governanceDegradedReason: "unreachable",
      stopReason: "execution-failed",
    }),
  );
  const tampered = JSON.parse(JSON.stringify(report)) as {
    steps: [Record<string, unknown>];
    governanceDegradedReason?: string;
  };
  tampered["steps"][0].degradedReason = "SECRET_TOKEN";
  tampered["steps"][0].error = "SECRET_TOKEN";
  tampered["steps"][0].tokensUnavailableReason = "SECRET_TOKEN";
  tampered["governanceDegradedReason"] = "SECRET_TOKEN";
  const parsed = parseReportJson(tampered);
  assert.equal(parsed.steps[0]?.degradedReason, "unknown");
  assert.equal(parsed.steps[0]?.error, "unknown");
  assert.equal(parsed.steps[0]?.tokensUnavailableReason, "unknown");
  assert.equal(parsed.governanceDegradedReason, "unknown");
  assert.ok(!JSON.stringify(parsed).includes("SECRET_TOKEN"));
  assert.ok(!renderReportMarkdown(parsed).includes("SECRET_TOKEN"));
});
test("Markdown 纯函数、结论与独立 evidence、无total、转义文本", () => {
  const report = buildReportJson(
    params({ scenario: "<script>alert(1)</script>|`x`", findings: [finding] }),
  );
  const md = renderReportMarkdown(report);
  assert.equal(md, renderReportMarkdown(report));
  assert.match(md, /停止原因/);
  assert.match(md, /step-limit/);
  assert.match(md, /Oracle 预期/);
  assert.match(md, /unknown/);
  assert.ok(!md.includes("<script>"));
  assert.ok(!md.includes("tokens 合计"));
  assert.match(md, /&#124;/);
});
test("公开动作 / 快照不保留可变引用", () => {
  const state = afterMove();
  const input = params({
    finalState: state,
    steps: [step({ observationAfter: { state, seq: 1, at: 2 } })],
  });
  const report = buildReportJson(input);
  (state.payload["board"] as number[][])[0]![0] = 2;
  assert.equal((report.finalState.payload["board"] as number[][])[0]![0], 0);
});
