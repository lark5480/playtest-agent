/**
 * CLI 入口
 *
 * 用法：
 *   npm run playtest -- --scenario smoke
 *   npm run playtest -- --scenario crash --inject-crash=10 --checkpoint=reports/checkpoints/crash.json
 *   npm run playtest -- --resume=reports/checkpoints/crash.json
 *   npm run playtest -- --scenario smoke --seed=123 --game-url=http://127.0.0.1:5173
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ChessArenaAdapter } from "./adapter/chess-arena.js";
import { OthelloLocalAdapter } from "./adapter/othello-local.js";
import type { GameAdapter } from "./adapter/game-adapter.js";
import { CliArgError, parseArgs, readInteger, readString } from "./cli-args.js";
import { buildReportJson } from "./core/report-core.js";
import type { ReportJson } from "./core/report-core.js";
import { mergeUsageIntoSteps } from "./core/cost-core.js";
import { FileCheckpointStore } from "./driver/checkpoint.js";
import {
  drive,
  InjectedCrash,
  ResumeDivergedError,
  ResumeUnavailableError,
} from "./driver/game-driver.js";
import { InMemoryGovernanceClient } from "./governance/client.js";
import { setupGovernance } from "./governance/setup.js";
import { clientFromEnv } from "./llm/openai-client.js";
import { ChessOracle } from "./oracle/chess.js";
import { CompositeOracle } from "./oracle/composite.js";
import { GenericOracle } from "./oracle/generic.js";
import type { Oracle } from "./oracle/oracle.js";
import { OthelloOracle } from "./oracle/othello.js";
import { defaultBaseName, writeReport, writeTextPair } from "./report/report-writer.js";
import { renderReportHtml } from "./report/report-html.js";
import {
  renderScanMarkdown,
  summarizeError,
  summarizeResult,
  summarizeRuns,
  type ScanRun,
} from "./scan/scan-core.js";
import { HeuristicStrategy } from "./strategy/heuristic.js";
import { LlmStrategy } from "./strategy/llm.js";
import { findScenario, loadScenarios } from "./scenarios/registry.js";
import type { Scenario } from "./scenarios/registry.js";
import type { GovernanceClient } from "./types/governance.js";
import type { StepRecord } from "./types/step.js";

async function main(): Promise<number> {
  const { command, options: args } = parseArgs(process.argv.slice(2));

  if (command === "scan") {
    return runScan(args);
  }

  if (command === "report") {
    return runReportHtml(args);
  }

  if (command !== "playtest") {
    console.error(
      "用法：\n" +
        "  playtest-agent playtest -- --scenario <名字> [--seed=N] [--game-url=URL] " +
        "[--checkpoint=路径] [--resume=路径]\n" +
        "  playtest-agent scan -- --scenario <名字> [--seeds=A-B] [--max-steps=N]\n" +
        "  playtest-agent report [--file=reports/xxx.json]",
    );
    return 2;
  }

  if (args.get("inject-crash") === "after-action") {
    console.error(
      "[playtest] --inject-crash=after-action 已废弃；请用步号，例如 --inject-crash=10",
    );
    return 2;
  }

  let seedArg: number | undefined;
  let injectAfter: number | undefined;
  let maxStepsOverride: number | undefined;
  try {
    seedArg = readInteger(args, "seed");
    injectAfter = readInteger(args, "inject-crash", { min: 0 });
    maxStepsOverride = readInteger(args, "max-steps", { min: 1 });
  } catch (error) {
    console.error(
      `[playtest] 参数错误：${error instanceof CliArgError ? error.message : String(error)}`,
    );
    return 2;
  }

  const scenarioName = readString(args, "scenario");

  const resumePath = readString(args, "resume");
  if (args.has("resume") && !resumePath) {
    console.error("[playtest] --resume 需要检查点文件路径");
    return 2;
  }
  if (args.has("checkpoint") && !readString(args, "checkpoint")) {
    console.error("[playtest] --checkpoint 需要文件路径");
    return 2;
  }
  let resume: ReturnType<FileCheckpointStore["read"]> | undefined;
  if (resumePath) {
    try {
      resume = new FileCheckpointStore(resumePath).read();
    } catch (error) {
      console.error(
        `[playtest] 无法读取检查点：${error instanceof Error ? error.message : String(error)}`,
      );
      return 4;
    }
  }

  const checkpointPath = readString(args, "checkpoint") ?? resumePath;
  const checkpoint = checkpointPath ? new FileCheckpointStore(checkpointPath) : undefined;

  const effectiveScenarioName = scenarioName ?? resume?.scenario ?? "smoke";
  const seed = seedArg ?? resume?.seed ?? 42;

  const scenarios = loadScenarios();
  const scenario = findScenario(scenarios, effectiveScenarioName);
  if (!scenario) {
    console.error(
      `未知场景 "${effectiveScenarioName}"。可用场景：${scenarios.map((s) => s.name).join(", ")}`,
    );
    return 2;
  }

  const gameUrl = readString(args, "game-url") ?? resolveGameUrl(scenario);
  const maxSteps = maxStepsOverride ?? scenario.maxSteps;

  const adapter = createAdapter(scenario, gameUrl);
  // 通用断言 + 游戏特异断言（特异断言独立实现，不复用游戏的规则代码）
  const oracle = createOracle(scenario);

  // 治理接入：优先真实 aiwarden，不可达则**显式**降级到内存替身。
  const governanceSetup = await setupGovernance({
    baseUrl: readString(args, "governance-url") ?? process.env.AIWARDEN_BASE_URL,
    forceInMemory: args.get("governance") === "in-memory",
  });
  const governance = governanceSetup.client;

  // 策略：有模型端点就用 LLM 策略（不可用时它**显式**降级并标注）；
  // 没有端点则直接用确定性基线 —— 两种情况都不会中断。
  const llmClient = clientFromEnv();
  const strategy = llmClient ? new LlmStrategy(llmClient) : new LlmStrategy(null);

  console.log(
    `[playtest] 场景=${scenario.name} seed=${seed} 被测=${gameUrl} ` +
      `模型=${llmClient ? llmClient.name : "未配置（走确定性基线）"} ` +
      `治理=${governance.name}${governanceSetup.degraded ? "（降级）" : ""} ` +
      `注入=${injectAfter ?? "无"} ` +
      `续跑=${resume ? `第 ${resume.nextStepNo} 步` : "否"}`,
  );
  if (governanceSetup.degraded && governanceSetup.reason) {
    console.log(`[playtest] 治理降级：${governanceSetup.reason}`);
  }

  try {
    const result = await drive({
      adapter,
      strategy,
      oracle,
      governance,
      scenario: scenario.name,
      seed,
      maxSteps,
      ...(injectAfter !== undefined ? { injectCrashAfterStep: injectAfter } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(resume ? { resume } : {}),
    });

    const report = buildReportJson({
      scenario: result.scenario,
      session: result.session,
      businessKey: result.businessKey,
      seed: result.seed,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      steps: await withUsage(result.steps, result.session, governance, result.startedAt),
      findings: result.findings,
      governanceSource: governance.name,
      ...(governanceSetup.reason ? { governanceDegradedReason: governanceSetup.reason } : {}),
    });

    const reportPaths = writeReport(report);
    console.log(
      `[playtest] 完成：${report.status} · ${report.stepCount} 步 · ` +
        `降级 ${report.degradedSteps} · 重放 ${report.replayedSteps} · 发现 ${report.findings.length}`,
    );
    console.log(
      `[playtest] 成本：llm ${report.usage.llm} · 治理 ${report.usage.governance} · ` +
        `来源 ${report.usage.sources.join("/") || "无"} · 无数据 ${report.usage.unavailableSteps} 步`,
    );
    console.log(`[playtest] 报告：${reportPaths.md}`);
    console.log(`[playtest] HTML：${reportPaths.html}`);
    return report.status === "failed" ? 1 : 0;
  } catch (error) {
    if (error instanceof InjectedCrash) {
      console.error(`[playtest] ${error.message}（续跑应从这里接着跑）`);
      if (checkpoint) {
        console.error(`[playtest] 检查点：${checkpoint.path}`);
      } else {
        console.error("[playtest] 未提供 --checkpoint，本次崩溃无法续跑");
      }
      return 3;
    }
    if (error instanceof ResumeUnavailableError || error instanceof ResumeDivergedError) {
      console.error(`[playtest] 续跑失败：${error.message}`);
      return 4;
    }
    console.error(`[playtest] 执行失败：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/**
 * 跑完后按 session 拉取治理侧用量，合并进步骤记录。
 *
 * 拿不到不阻断运行：显式标 unavailable，报告里能看到原因。
 */
async function withUsage(
  steps: readonly StepRecord[],
  session: string,
  governance: GovernanceClient,
  startedAt: number,
): Promise<readonly StepRecord[]> {
  if (typeof governance.queryUsage !== "function") return steps;
  try {
    const usage = await governance.queryUsage({
      session,
      expectedSteps: steps.map((step) => step.stepNo),
      // 只统计本次运行开始之后的用量，隔离同 session 的历史行。
      since: startedAt,
    });
    return mergeUsageIntoSteps(steps, usage);
  } catch (error) {
    return mergeUsageIntoSteps(steps, {
      source: "unavailable",
      byStep: [],
      unavailableReason: `成本查询失败：${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * 批量扫描：固定策略跑多个 seed，汇总断言发现。
 *
 * 扫描只回答「在这组 seed / 步数 / 断言下看到了什么」，
 * **不**替人判断是不是真实游戏缺陷（Oracle 误报需先排除）。
 */
async function runScan(args: ReadonlyMap<string, string>): Promise<number> {
  let scenarioName: string | undefined;
  let seedRange: { readonly from?: number; readonly to?: number };
  let maxStepsOverride: number | undefined;
  let gapOverride: number | undefined;
  try {
    scenarioName = readString(args, "scenario");
    seedRange = parseSeedRange(readString(args, "seeds"));
    maxStepsOverride = readInteger(args, "max-steps", { min: 1 });
    gapOverride = readInteger(args, "gap-ms", { min: 0 });
  } catch (error) {
    console.error(
      `[scan] 参数错误：${error instanceof CliArgError ? error.message : String(error)}`,
    );
    return 2;
  }

  const scenarios = loadScenarios();
  const scenario = findScenario(scenarios, scenarioName ?? "smoke");
  if (!scenario) {
    console.error(
      `[scan] 未知场景 "${scenarioName ?? "smoke"}"。可用：${scenarios.map((s) => s.name).join(", ")}`,
    );
    return 2;
  }

  const gameUrl = readString(args, "game-url") ?? resolveGameUrl(scenario);
  const maxSteps = maxStepsOverride ?? (scenario.game === "chess" ? 40 : scenario.maxSteps);
  const from = seedRange.from ?? 1;
  const to = seedRange.to ?? (scenario.game === "chess" ? 3 : 50);
  const gapMs = gapOverride ?? (scenario.game === "chess" ? 61_000 : 0);
  const coverage =
    scenario.game === "chess" ? "通用 G1–G5 + 象棋 CHS1–CHS15" : "通用 G1–G5 + 黑白棋 OTH1–OTH10";

  console.log(
    `[scan] 场景=${scenario.name} seeds=${from}-${to} 步数上限=${maxSteps} ` +
      `被测=${gameUrl} 覆盖=${coverage}`,
  );

  const startedAt = Date.now();
  const runs: ScanRun[] = [];

  for (let seed = from; seed <= to; seed += 1) {
    const adapter = createAdapter(scenario, gameUrl);
    const oracle = createOracle(scenario);
    try {
      const result = await drive({
        adapter,
        strategy: new HeuristicStrategy(),
        oracle,
        governance: new InMemoryGovernanceClient(),
        scenario: scenario.name,
        seed,
        maxSteps,
      });
      const run = summarizeResult(seed, result);
      runs.push(run);
      console.log(
        `[scan] seed=${seed} ${run.status} · ${run.steps} 步 · 发现 ${run.findings.length}`,
      );
    } catch (error) {
      const run = summarizeError(seed, error);
      runs.push(run);
      console.error(`[scan] seed=${seed} 失败：${run.error ?? "未知错误"}`);
    }

    if (seed < to && gapMs > 0) await sleep(gapMs);
  }

  const finishedAt = Date.now();
  const summary = summarizeRuns({
    scenario: scenario.name,
    game: scenario.game,
    seedFrom: from,
    seedTo: to,
    maxSteps,
    coverage,
    startedAt,
    finishedAt,
    runs,
  });

  const reportDir = readString(args, "report-dir");
  const paths = writeTextPair({
    ...(reportDir ? { dir: reportDir } : {}),
    baseName: defaultBaseName(`scan-${scenario.name}`, finishedAt),
    markdown: renderScanMarkdown(summary),
    json: summary,
  });

  console.log(
    `[scan] 完成：${summary.totals.runs} 局 · ${summary.totals.steps} 步 · ` +
      `发现 ${summary.totals.findings}（待人工复核）`,
  );
  console.log(`[scan] 报告：${paths.md}`);

  if (summary.totals.runs > 0 && summary.totals.incomplete === summary.totals.runs) {
    console.error("[scan] 所有 seed 都失败：请检查被测游戏与 --game-url");
    return 1;
  }
  return 0;
}

function parseSeedRange(raw: string | undefined): { readonly from?: number; readonly to?: number } {
  if (!raw) return {};
  const match = /^(\d+)(?:-(\d+))?$/.exec(raw.trim());
  if (!match) throw new CliArgError("--seeds 格式应为 N 或 A-B（例如 1-50）");
  const from = Number(match[1]);
  const to = Number(match[2] ?? match[1]);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
    throw new CliArgError("--seeds 超出安全整数范围");
  }
  if (to < from) throw new CliArgError(`--seeds 区间非法：${from}-${to}`);
  if (to - from > 199) throw new CliArgError("--seeds 单次最多 200 个");
  return { from, to };
}

function createAdapter(scenario: Scenario, gameUrl: string): GameAdapter {
  return scenario.game === "chess"
    ? new ChessArenaAdapter({ baseUrl: gameUrl })
    : new OthelloLocalAdapter({ baseUrl: gameUrl });
}

function resolveGameUrl(scenario: Scenario): string {
  if (scenario.game === "chess") {
    return process.env.CHESS_ARENA_BASE_URL ?? process.env.GAME_BASE_URL ?? "http://localhost:3000";
  }
  return process.env.GAME_BASE_URL ?? "http://localhost:5173";
}

function createOracle(scenario: Scenario): Oracle {
  const gameOracle = scenario.game === "chess" ? new ChessOracle() : new OthelloOracle();
  return new CompositeOracle([new GenericOracle(), gameOracle]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * 把已有报告 JSON 重新渲染成自包含 HTML。
 *
 * 用途：Qoder 的 Web 预览在部分环境无法注册 ServiceWorker；
 * HTML 不依赖 ServiceWorker，直接用浏览器打开即可。
 */
async function runReportHtml(args: ReadonlyMap<string, string>): Promise<number> {
  const requested = readString(args, "file");
  const requestedJson = requested
    ? resolve(requested.endsWith(".md") ? requested.replace(/\.md$/i, ".json") : requested)
    : undefined;
  const jsonPath = requestedJson ?? findLatestReportJson();

  if (!jsonPath || !existsSync(jsonPath)) {
    console.error("[report] 找不到报告 JSON；请用 --file=reports/xxx.json");
    return 2;
  }

  let report: ReportJson;
  try {
    report = JSON.parse(readFileSync(jsonPath, "utf8")) as ReportJson;
  } catch (error) {
    console.error(
      `[report] 无法读取 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
  if (report.schemaVersion !== 1) {
    console.error("[report] 不是 playtest 报告 JSON（schemaVersion 必须为 1）");
    return 2;
  }

  const htmlPath = jsonPath.replace(/\.json$/i, ".html");
  writeFileSync(htmlPath, renderReportHtml(report), "utf8");
  console.log(`[report] HTML：${htmlPath}`);
  return 0;
}

function findLatestReportJson(): string | undefined {
  const dir = resolve("reports");
  if (!existsSync(dir)) return undefined;

  const candidates = readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.startsWith("scan-"))
    .map((name) => {
      const path = join(dir, name);
      return { path, mtime: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate.path, "utf8")) as {
        schemaVersion?: unknown;
      };
      if (parsed.schemaVersion === 1) return candidate.path;
    } catch {
      // 跳过非报告 JSON
    }
  }
  return undefined;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
