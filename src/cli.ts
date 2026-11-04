/**
 * CLI 入口
 *
 * 用法：
 *   npm run playtest -- --scenario smoke
 *   npm run playtest -- --scenario crash --inject-crash=after-action
 *   npm run playtest -- --scenario smoke --seed=123 --game-url=http://127.0.0.1:5173
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { ChessArenaAdapter } from "./adapter/chess-arena.js";
import { OthelloLocalAdapter } from "./adapter/othello-local.js";
import { buildReportJson, renderReportMarkdown } from "./core/report-core.js";
import { drive, InjectedCrash } from "./driver/game-driver.js";
import { setupGovernance } from "./governance/setup.js";
import { clientFromEnv } from "./llm/openai-client.js";
import { ChessOracle } from "./oracle/chess.js";
import { CompositeOracle } from "./oracle/composite.js";
import { GenericOracle } from "./oracle/generic.js";
import { OthelloOracle } from "./oracle/othello.js";
import { LlmStrategy } from "./strategy/llm.js";
import { findScenario, loadScenarios } from "./scenarios/registry.js";

const REPORTS_DIR = resolve(process.cwd(), "reports");

/**
 * 解析参数。
 *
 * 第一个非 `--` 开头的词是**子命令**（如 `playtest`），其余 `--key=value` 是选项。
 * `npm run playtest -- --scenario smoke` 传入的 argv 形如
 * `["playtest", "--", "--scenario", "smoke"]` —— 注意 `--` 与分离式取值都要处理。
 */
function parseArgs(argv: readonly string[]): { command: string; options: Map<string, string> } {
  const options = new Map<string, string>();
  let command = "";
  let pendingKey: string | null = null;

  for (const arg of argv) {
    if (arg === "--") continue;

    if (pendingKey) {
      options.set(pendingKey, arg);
      pendingKey = null;
      continue;
    }

    if (arg.startsWith("--")) {
      const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
      if (match) {
        const key = match[1]!;
        const value = match[2];
        if (value === undefined) {
          // 分离式取值：`--scenario smoke` —— 值在下一个参数
          pendingKey = key;
        } else {
          options.set(key, value);
        }
      }
      continue;
    }

    if (!command) {
      command = arg;
    }
  }

  return { command, options };
}

async function main(): Promise<number> {
  const { command, options: args } = parseArgs(process.argv.slice(2));

  if (command !== "playtest") {
    console.error(`用法：playtest-agent playtest -- --scenario <名字> [--seed=N] [--game-url=URL]`);
    return 2;
  }

  const scenarioName = args.get("scenario") ?? "smoke";
  const seed = Number(args.get("seed") ?? 42);
  const injectAfter = args.get("inject-crash");

  const scenarios = loadScenarios();
  const scenario = findScenario(scenarios, scenarioName);
  if (!scenario) {
    console.error(
      `未知场景 "${scenarioName}"。可用场景：${scenarios.map((s) => s.name).join(", ")}`,
    );
    return 2;
  }

  const defaultGameUrl =
    scenario.game === "chess" ? "http://localhost:3000" : "http://localhost:5173";
  const gameUrl = args.get("game-url") ?? process.env.GAME_BASE_URL ?? defaultGameUrl;

  const adapter =
    scenario.game === "chess"
      ? new ChessArenaAdapter({ baseUrl: gameUrl })
      : new OthelloLocalAdapter({ baseUrl: gameUrl });
  // 通用断言 + 游戏特异断言（特异断言独立实现，不复用游戏的规则代码）
  const gameOracle = scenario.game === "chess" ? new ChessOracle() : new OthelloOracle();
  const oracle = new CompositeOracle([new GenericOracle(), gameOracle]);

  // 治理接入：优先真实 aiwarden，不可达则**显式**降级到内存替身。
  const governanceSetup = await setupGovernance({
    baseUrl: args.get("governance-url") ?? process.env.AIWARDEN_BASE_URL,
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
      `注入=${injectAfter ?? "无"}`,
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
      maxSteps: scenario.maxSteps,
      ...(injectAfter ? { injectCrashAfterStep: Number(injectAfter) } : {}),
    });

    const report = buildReportJson({
      scenario: result.scenario,
      session: result.session,
      businessKey: result.businessKey,
      seed: result.seed,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      steps: result.steps,
      findings: result.findings,
      governanceSource: governance.name,
      ...(governanceSetup.reason ? { governanceDegradedReason: governanceSetup.reason } : {}),
    });

    mkdirSync(REPORTS_DIR, { recursive: true });
    const stamp = new Date(result.finishedAt).toISOString().replace(/[:.]/g, "-");
    const base = `${REPORTS_DIR}/${scenario.name}-${stamp}`;
    writeFileSync(`${base}.md`, renderReportMarkdown(report), "utf8");
    writeFileSync(`${base}.json`, JSON.stringify(report, null, 2), "utf8");

    console.log(
      `[playtest] 完成：${report.status} · ${report.stepCount} 步 · ` +
        `降级 ${report.degradedSteps} · 重放 ${report.replayedSteps} · 发现 ${report.findings.length}`,
    );
    console.log(`[playtest] 报告：${base}.md`);
    return report.status === "failed" ? 1 : 0;
  } catch (error) {
    if (error instanceof InjectedCrash) {
      console.error(`[playtest] ${error.message}（续跑应从这里接着跑）`);
      return 3;
    }
    console.error(`[playtest] 执行失败：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
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
