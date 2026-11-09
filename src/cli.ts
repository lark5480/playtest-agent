import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { ChessArenaAdapter } from "./adapter/chess-arena.js";
import { OthelloLocalAdapter } from "./adapter/othello-local.js";
import { CliArgError, parseArgs, readInteger, readString } from "./cli-args.js";
import { mergeUsageIntoSteps } from "./core/cost-core.js";
import { explorationMetrics } from "./core/exploration.js";
import { parseReportJson } from "./core/recording.js";
import { buildReportJson, reportExitCode, type ReportJson } from "./core/report-core.js";
import { diffReports, renderDiffMarkdown } from "./core/report-diff.js";
import { startOthelloStubServer } from "./demo/othello-server.js";
import { FileCheckpointStore } from "./driver/checkpoint.js";
import {
  drive,
  InjectedCrash,
  ResumeDivergedError,
  ResumeUnavailableError,
} from "./driver/game-driver.js";
import { InMemoryGovernanceClient } from "./governance/client.js";
import { setupGovernance } from "./governance/setup.js";
import { BatchBudget, BudgetedLlmClient } from "./llm/budgeted-client.js";
import { clientFromEnv } from "./llm/openai-client.js";
import { ChessOracle } from "./oracle/chess.js";
import { CompositeOracle } from "./oracle/composite.js";
import { GenericOracle } from "./oracle/generic.js";
import { OthelloOracle } from "./oracle/othello.js";
import { replayRecording } from "./replay/replay.js";
import { renderReportHtml } from "./report/report-html.js";
import { defaultBaseName, writeReport, writeTextPair } from "./report/report-writer.js";
import { renderScanMarkdown, summarizeRuns, type ScanRun } from "./scan/scan-core.js";
import {
  findScenario,
  loadScenarios,
  MODEL_BUDGET_DEFAULTS,
  type Scenario,
} from "./scenarios/registry.js";
import { EXPLORATION_PROMPT_VERSION } from "./strategy/llm.js";
import { createStrategy } from "./strategy/factory.js";
import { HeuristicStrategy } from "./strategy/heuristic.js";
import type { GovernanceClient } from "./types/governance.js";
import type { GameKind, RunMetadata } from "./types/run.js";
import type { StepRecord } from "./types/step.js";

type StrategyKind = "auto" | "heuristic" | "llm" | "llm-explore";
function strategyKind(value: string | undefined, fallback: StrategyKind): StrategyKind {
  const kind = value ?? fallback;
  if (kind === "auto" || kind === "heuristic" || kind === "llm" || kind === "llm-explore")
    return kind;
  throw new CliArgError("--strategy 必须为 auto / heuristic / llm / llm-explore");
}
function targetOf(args: ReadonlyMap<string, string>): string | undefined {
  const target = readString(args, "target");
  if (target !== undefined && !["corner", "pass", "terminal"].includes(target))
    throw new CliArgError("--target 必须为 corner / pass / terminal");
  return target;
}
function checkpointPath(path: string): string {
  const root = resolve("reports/checkpoints");
  const full = resolve(path);
  const rel = relative(root, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new CliArgError("检查点必须位于 reports/checkpoints/");
  let current = full;
  while (current !== dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new CliArgError("检查点路径不得经过符号链接");
    current = dirname(current);
  }
  return full;
}
function localTarget(raw: string | undefined): string {
  if (!raw) throw new CliArgError("replay 需要显式 --game-url 指定本地目标");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliArgError("被测服务地址无效");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new CliArgError("replay 只接受无认证信息的本地 HTTP 地址");
  return url.href.replace(/\/$/, "");
}
function createAdapter(game: GameKind, baseUrl: string) {
  return game === "chess"
    ? new ChessArenaAdapter({ baseUrl })
    : new OthelloLocalAdapter({ baseUrl });
}
function createOracle(game: GameKind) {
  return new CompositeOracle([
    new GenericOracle(),
    game === "chess" ? new ChessOracle() : new OthelloOracle(),
  ]);
}
function resolveGameUrl(scenario: Scenario): string {
  return scenario.game === "chess"
    ? (process.env.CHESS_ARENA_BASE_URL ?? process.env.GAME_BASE_URL ?? "http://localhost:3000")
    : (process.env.GAME_BASE_URL ?? "http://localhost:5173");
}
let version: string | undefined;
function agentVersion(): string {
  if (version) return version;
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    version = `${sha}${dirty ? "+dirty" : ""}`;
  } catch {
    version = "unknown";
  }
  return version;
}
function metadata(
  game: GameKind,
  strategy: string,
  maxSteps: number,
  targetVersion = "unknown",
): RunMetadata {
  return {
    game,
    adapter: game === "chess" ? "chess-arena" : "othello-local",
    oracle: game === "chess" ? "generic+chess" : "generic+othello",
    strategy,
    agentVersion: agentVersion(),
    targetVersion,
    source: "local-service",
    maxSteps,
  };
}
async function withUsage(
  steps: readonly StepRecord[],
  session: string,
  governance: GovernanceClient,
  since: number,
) {
  if (!governance.queryUsage) return steps;
  try {
    return mergeUsageIntoSteps(
      steps,
      await governance.queryUsage({ session, expectedSteps: steps.map((s) => s.stepNo), since }),
    );
  } catch {
    return mergeUsageIntoSteps(steps, {
      source: "unavailable",
      byStep: [],
      unavailableReason: "usage-query-failed",
    });
  }
}
async function executePlaytest(args: ReadonlyMap<string, string>, batch?: BatchBudget) {
  const explicit = readString(args, "resume") ?? readString(args, "checkpoint");
  let store = explicit ? new FileCheckpointStore(checkpointPath(explicit)) : undefined;
  try {
    store?.acquire();
    const resume = args.has("resume") ? store?.read() : undefined;
    const scenario = findScenario(
      loadScenarios(),
      readString(args, "scenario") ?? resume?.scenario ?? "smoke",
    );
    if (!scenario) throw new CliArgError("未知场景");
    const seed = readInteger(args, "seed") ?? resume?.seed ?? 42;
    const maxSteps = readInteger(args, "max-steps", { min: 1 }) ?? scenario.maxSteps;
    const kind = strategyKind(readString(args, "strategy"), "auto");
    const target = targetOf(args);
    if (kind === "llm-explore" && scenario.game !== "othello")
      throw new CliArgError("探索目标当前仅支持黑白棋");
    const client = kind === "heuristic" ? null : clientFromEnv();
    if (resume?.budget && !client)
      throw new ResumeUnavailableError("模型预算检查点需要恢复原模型配置");
    const session = resume?.session ?? `pt-${randomUUID()}`;
    if (client && !store) {
      store = new FileCheckpointStore(checkpointPath(`reports/checkpoints/${session}.json`));
      store.acquire();
    }
    const tokenLimit =
      readInteger(args, "llm-token-limit", { min: 1 }) ?? resume?.budget?.tokenLimit;
    const budget = client
      ? new BudgetedLlmClient(client, {
          maxCalls:
            readInteger(args, "max-model-calls", { min: 0 }) ??
            resume?.budget?.maxCalls ??
            MODEL_BUDGET_DEFAULTS.playtest,
          ...(tokenLimit !== undefined ? { tokenLimit } : {}),
          ...(resume?.budget ? { initial: resume.budget } : {}),
          ...(batch ? { batch } : {}),
        })
      : undefined;
    const strategy = createStrategy(kind, budget ?? client);
    const setup = await setupGovernance({
      baseUrl: readString(args, "governance-url") ?? process.env.AIWARDEN_BASE_URL,
      forceInMemory: args.get("governance") === "in-memory",
    });
    const inject = readInteger(args, "inject-crash", { min: 0 });
    const result = await drive({
      adapter: createAdapter(
        scenario.game,
        readString(args, "game-url") ?? resolveGameUrl(scenario),
      ),
      oracle: createOracle(scenario.game),
      strategy,
      governance: setup.client,
      scenario: scenario.name,
      seed,
      session,
      maxSteps,
      ...(store ? { checkpoint: store } : {}),
      ...(resume ? { resume } : {}),
      ...(budget ? { budget } : {}),
      ...(target || kind === "llm-explore"
        ? { exploration: { game: scenario.game, target: target ?? "pass" } }
        : {}),
      ...(inject !== undefined ? { injectCrashAfterStep: inject } : {}),
    });
    const meta: RunMetadata = {
      ...metadata(
        scenario.game,
        strategy.name,
        maxSteps,
        readString(args, "target-version") ?? "unknown",
      ),
      ...(target || kind === "llm-explore" ? { target: target ?? "pass" } : {}),
      ...(kind === "llm-explore" ? { promptVersion: EXPLORATION_PROMPT_VERSION } : {}),
    };
    const report = buildReportJson({
      ...result,
      metadata: meta,
      steps: await withUsage(result.steps, result.session, setup.client, result.startedAt),
      governanceSource: setup.client.name,
      ...(setup.reason ? { governanceDegradedReason: setup.reason } : {}),
    });
    const reportDir = readString(args, "report-dir");
    const paths = writeReport(report, reportDir ? { dir: reportDir } : {});
    console.log(
      `[playtest] ${report.status} · 结束=${report.stopReason} · 终局=${report.gameTerminal} · ${report.stepCount} 步 · 降级 ${report.degradedSteps} · 发现 ${report.findings.length}`,
    );
    console.log(`[playtest] 报告：${paths.md}`);
    if (report.status === "passed") store?.remove();
    else if (store) console.log(`[playtest] 检查点：${store.path}`);
    return {
      report,
      paths,
      metrics: explorationMetrics(scenario.game, result.initialState, result.steps),
    };
  } catch (error) {
    if (error instanceof InjectedCrash && store) console.error(`[playtest] 检查点：${store.path}`);
    throw error;
  } finally {
    store?.release();
  }
}
function readReport(path: string): ReportJson {
  try {
    return parseReportJson(JSON.parse(readFileSync(resolve(path), "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) throw new CliArgError("报告不是合法 JSON");
    throw new CliArgError(error instanceof Error ? error.message : "报告读取失败");
  }
}
function seedRange(raw: string | undefined): { from: number; to: number } {
  const match = /^(\d+)(?:-(\d+))?$/.exec(raw ?? "1-3");
  if (!match) throw new CliArgError("--seeds 格式应为 N 或 A-B");
  const from = Number(match[1]);
  const to = Number(match[2] ?? match[1]);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from || to - from > 199)
    throw new CliArgError("seed 区间无效，单次最多200个");
  return { from, to };
}
async function runScan(args: ReadonlyMap<string, string>): Promise<number> {
  if (args.has("resume") || args.has("checkpoint"))
    throw new CliArgError("scan 不支持整批续跑或共用一个检查点");
  const scenario = findScenario(loadScenarios(), readString(args, "scenario") ?? "smoke");
  if (!scenario) throw new CliArgError("未知场景");
  const comparing = args.has("compare");
  if (comparing && args.get("compare") !== "heuristic,llm-explore")
    throw new CliArgError("--compare 当前支持 heuristic,llm-explore");
  const kinds: StrategyKind[] = comparing
    ? ["heuristic", "llm-explore"]
    : [strategyKind(readString(args, "strategy"), "heuristic")];
  if (comparing && !clientFromEnv())
    throw new CliArgError("模型对照需要配置模型；不会把基线降级当成AI样本");
  if (comparing && scenario.game !== "othello") throw new CliArgError("成对探索当前仅支持黑白棋");
  const range = seedRange(
    readString(args, "seeds") ?? (scenario.game === "chess" ? "1-3" : "1-50"),
  );
  const maxCalls = readInteger(args, "max-model-calls", { min: 0 }) ?? MODEL_BUDGET_DEFAULTS.scan;
  const batch = new BatchBudget(
    readInteger(args, "max-batch-model-calls", { min: 0 }) ?? MODEL_BUDGET_DEFAULTS.batch,
  );
  const startedAt = Date.now();
  const runs: ScanRun[] = [];
  const maxSteps =
    readInteger(args, "max-steps", { min: 1 }) ??
    (comparing ? 10 : scenario.game === "chess" ? 40 : scenario.maxSteps);
  const gap = readInteger(args, "gap-ms", { min: 0 }) ?? (scenario.game === "chess" ? 61_000 : 0);
  for (let seed = range.from; seed <= range.to; seed += 1) {
    for (const kind of kinds) {
      if (batch.exhausted && kinds.some((k) => k !== "heuristic")) {
        runs.push({
          seed,
          strategy: kind,
          status: "not-run",
          exitCode: 5,
          reason: "整批模型调用额度已耗尽",
        });
        continue;
      }
      const options = new Map(args);
      options.set("strategy", kind);
      options.set("seed", String(seed));
      options.set("max-steps", String(maxSteps));
      options.set("max-model-calls", String(maxCalls));
      options.set("governance", "in-memory");
      if (comparing) options.set("target", targetOf(args) ?? "pass");
      try {
        const result = await executePlaytest(options, batch);
        runs.push({
          seed,
          strategy: kind,
          status: result.report.status,
          exitCode: reportExitCode(result.report),
          report: result.report,
          reportFile: result.paths.json,
          metrics: result.metrics,
        });
      } catch (error) {
        if (error instanceof CliArgError) throw error;
        runs.push({
          seed,
          strategy: kind,
          status: "incomplete",
          exitCode: 6,
          reason: "该局执行失败，未获得完整报告",
        });
      }
      if (gap > 0 && seed < range.to)
        await new Promise((resolvePromise) => setTimeout(resolvePromise, gap));
    }
  }
  const summary = summarizeRuns({
    scenario: scenario.name,
    game: scenario.game,
    seedFrom: range.from,
    seedTo: range.to,
    maxSteps,
    startedAt,
    finishedAt: Date.now(),
    runs,
    comparing,
  });
  const dir = readString(args, "report-dir");
  const paths = writeTextPair({
    ...(dir ? { dir } : {}),
    baseName: defaultBaseName(`scan-${scenario.name}`, summary.finishedAt),
    markdown: renderScanMarkdown(summary),
    json: summary,
  });
  console.log(`[scan] 汇总：${paths.md}`);
  return summary.exitCode;
}
async function runDemo(args: ReadonlyMap<string, string>): Promise<number> {
  const fault = "missed-flip" as const;
  const dir = readString(args, "report-dir");
  const options = dir ? { dir } : {};
  const initial = await startOthelloStubServer({ fault });
  let recording: ReportJson;
  try {
    const result = await drive({
      adapter: createAdapter("othello", initial.baseUrl),
      oracle: createOracle("othello"),
      strategy: new HeuristicStrategy(),
      governance: new InMemoryGovernanceClient(),
      scenario: "demo-missed-flip",
      seed: 42,
      maxSteps: 20,
    });
    recording = buildReportJson({
      ...result,
      metadata: {
        ...metadata("othello", "heuristic-random", 20, "othello-fixture-v1:missed-flip@5"),
        source: "injected-fixture",
      },
      governanceSource: "in-memory",
    });
  } finally {
    await initial.close();
  }
  const beforePaths = writeReport(recording, {
    ...options,
    baseName: defaultBaseName("demo-before", Date.now()),
  });
  recording = readReport(beforePaths.json);
  if (!recording.findings.some((f) => f.code === "OTH2-board-projection-mismatch"))
    throw new Error("预置漏翻错误未被检出");
  const results = [];
  for (const healthy of [false, true]) {
    const server = await startOthelloStubServer(healthy ? {} : { fault });
    try {
      const result = await replayRecording(recording, {
        adapter: createAdapter("othello", server.baseUrl),
        oracle: createOracle("othello"),
        metadata: {
          ...metadata(
            "othello",
            "recorded",
            recording.stepCount,
            healthy ? "othello-fixture-v1:healthy" : "othello-fixture-v1:missed-flip@5",
          ),
          source: healthy ? "healthy-fixture" : "injected-fixture",
        },
      });
      const paths = writeReport(result.report, {
        ...options,
        baseName: defaultBaseName(healthy ? "demo-healthy" : "demo-reproduced", Date.now()),
      });
      console.log(`[demo] ${result.outcome} · ${result.message}`);
      results.push({ ...result, paths });
    } finally {
      await server.close();
    }
  }
  const reproduced = results[0]!;
  const healthy = results[1]!;
  const passed = reproduced.outcome === "reproduced" && healthy.outcome === "not-reproduced";
  const diff = diffReports(reproduced.report, healthy.report);
  const summary = writeTextPair({
    ...options,
    baseName: defaultBaseName("demo-summary", Date.now()),
    markdown: `# 预置缺陷闭环\n\n来源：injected-fixture，不是真实游戏缺陷。\n\n- 发现：${beforePaths.json}\n- 新会话复现：${reproduced.outcome}\n- 健康前缀对照：${healthy.outcome}\n\n${renderDiffMarkdown(diff)}`,
    json: {
      source: "injected-fixture",
      passed,
      before: beforePaths.json,
      reproduced: reproduced.paths.json,
      healthy: healthy.paths.json,
      diff,
    },
  });
  console.log(`[demo] ${passed ? "闭环通过" : "闭环失败"} · ${summary.md}`);
  return passed ? 0 : 1;
}
async function runReplay(args: ReadonlyMap<string, string>): Promise<number> {
  const file = readString(args, "file");
  if (!file) throw new CliArgError("replay 需要 --file");
  const recording = readReport(file);
  const target = localTarget(readString(args, "game-url"));
  const result = await replayRecording(recording, {
    adapter: createAdapter(recording.metadata.game, target),
    oracle: createOracle(recording.metadata.game),
    metadata: metadata(
      recording.metadata.game,
      "recorded",
      recording.stepCount,
      readString(args, "target-version") ?? "unknown",
    ),
  });
  const dir = readString(args, "report-dir");
  const paths = writeReport(result.report, {
    baseName: defaultBaseName("replay", Date.now()),
    ...(dir ? { dir } : {}),
  });
  console.log(`[replay] ${result.outcome} · ${result.message} · 报告：${paths.json}`);
  if (result.report.stopReason === "execution-failed") return 6;
  return result.outcome === "reproduced" || result.outcome === "verified"
    ? 0
    : result.outcome === "inconclusive"
      ? 5
      : 4;
}
function latestReport(): string | undefined {
  if (!existsSync("reports")) return undefined;
  return readdirSync("reports")
    .filter((name) => name.endsWith(".json") && !/^(scan|demo-summary|diff)-/.test(name))
    .map((name) => ({
      path: resolve("reports", name),
      time: statSync(resolve("reports", name)).mtimeMs,
    }))
    .sort((a, b) => b.time - a.time)
    .find((entry) => {
      try {
        readReport(entry.path);
        return true;
      } catch {
        return false;
      }
    })?.path;
}
async function main(): Promise<number> {
  const { command, options: args } = parseArgs(process.argv.slice(2));
  for (const [key, value] of args) if (value === "") throw new CliArgError(`--${key} 需要取值`);
  if (command === "playtest") return reportExitCode((await executePlaytest(args)).report);
  if (command === "scan") return runScan(args);
  if (command === "demo") return runDemo(args);
  if (command === "replay") return runReplay(args);
  if (command === "report") {
    const file = readString(args, "file")?.replace(/\.md$/i, ".json") ?? latestReport();
    if (!file) throw new CliArgError("请通过 --file 指定报告 JSON");
    const output = resolve(file).replace(/\.json$/i, "") + ".html";
    writeFileSync(output, renderReportHtml(readReport(file)), "utf8");
    console.log(`[report] HTML：${output}`);
    return 0;
  }
  if (command === "diff") {
    const before = readString(args, "before");
    const after = readString(args, "after");
    if (!before || !after) throw new CliArgError("diff 需要 --before 与 --after");
    const diff = diffReports(readReport(before), readReport(after));
    const paths = writeTextPair({
      baseName: defaultBaseName("diff", Date.now()),
      markdown: renderDiffMarkdown(diff),
      json: diff,
    });
    console.log(`[diff] ${diff.conclusion} · ${paths.md}`);
    return diff.comparable ? (diff.addedFindings.length > 0 ? 1 : 0) : 5;
  }
  throw new CliArgError("用法：playtest | scan | demo | replay | report | diff");
}
main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof CliArgError) {
      console.error(`[cli] ${error.message}`);
      process.exitCode = 2;
    } else if (error instanceof InjectedCrash) {
      console.error(`[playtest] ${error.message}`);
      process.exitCode = 3;
    } else if (error instanceof ResumeUnavailableError || error instanceof ResumeDivergedError) {
      console.error(`[playtest] 续跑失败：${error.message}`);
      process.exitCode = 4;
    } else {
      const detail =
        error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : "unknown";
      console.error(`[playtest] 执行失败；${detail}`);
      process.exitCode = 6;
    }
  },
);
