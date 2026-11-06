import assert from "node:assert/strict";
import { test } from "node:test";
import { params } from "./helpers/report-fixtures.js";
import { buildReportJson } from "../src/core/report-core.js";
import { renderScanMarkdown, summarizeRuns } from "../src/scan/scan-core.js";

function run(seed: number, strategy: string, exitCode: number, scenario = "smoke") {
  return {
    seed,
    strategy,
    status: exitCode === 0 ? ("passed" as const) : ("incomplete" as const),
    exitCode,
    report: buildReportJson(params({ seed, scenario })),
    reportFile: `reports/${scenario}-${seed}.json`,
    metrics: {
      uniqueStates: seed,
      events: {
        corner: { status: "applicable" as const, count: 0, firstStep: null },
        pass: { status: "not-applicable" as const },
        terminal: { status: "applicable" as const, count: 0, firstStep: null },
      },
    },
  };
}

test("整批退出按 6 > 1 > 5 > 0 聚合，不因部分成功忽略失败", () => {
  assert.equal(
    summarizeRuns({
      scenario: "smoke",
      game: "othello",
      seedFrom: 1,
      seedTo: 3,
      maxSteps: 10,
      startedAt: 1,
      finishedAt: 2,
      comparing: false,
      runs: [run(1, "heuristic", 0), run(2, "heuristic", 6), run(3, "heuristic", 5)],
    }).exitCode,
    6,
  );
  assert.equal(
    summarizeRuns({
      scenario: "smoke",
      game: "othello",
      seedFrom: 1,
      seedTo: 2,
      maxSteps: 10,
      startedAt: 1,
      finishedAt: 2,
      comparing: false,
      runs: [run(1, "heuristic", 0), run(2, "heuristic", 5)],
    }).exitCode,
    5,
  );
  assert.equal(
    summarizeRuns({
      scenario: "smoke",
      game: "othello",
      seedFrom: 1,
      seedTo: 1,
      maxSteps: 10,
      startedAt: 1,
      finishedAt: 2,
      comparing: false,
      runs: [run(1, "heuristic", 0)],
    }).exitCode,
    0,
  );
});

test("成对对照要求同一窗口且无降级；不可比给出原因不硬算差值", () => {
  const summary = summarizeRuns({
    scenario: "smoke",
    game: "othello",
    seedFrom: 1,
    seedTo: 1,
    maxSteps: 10,
    startedAt: 1,
    finishedAt: 2,
    comparing: true,
    runs: [
      run(1, "heuristic", 0),
      {
        ...run(1, "llm-explore", 0),
        report: buildReportJson(
          params({
            seed: 1,
            metadata: {
              ...params().metadata,
              maxSteps: 10,
              strategy: "llm-explore",
              promptVersion: "exploration-v1",
            },
          }),
        ),
      },
    ],
  });
  assert.equal(summary.pairs[0]?.comparable, false);
  assert.ok(
    summary.pairs[0]?.reasons.some((reason) => reason.includes("步限") || reason.includes("不同")),
  );
  assert.equal(summary.pairs[0]?.uniqueStateDelta, undefined);
  const markdown = renderScanMarkdown(summary);
  assert.match(markdown, /不可比/);
  assert.match(markdown, /不预设 AI 胜出/);
  assert.match(markdown, /唯一局面/);
  assert.doesNotMatch(markdown, /覆盖 G1/);
});
