/**
 * 集成测试 · 真进程崩溃续跑
 *
 * 父进程起 othello 假服务；子进程跑 CLI：
 *   1) --inject-crash=10 --checkpoint=... → 退出码 3，留下 pending 检查点；
 *   2) --resume=... → 退出码 0，报告完整、pending 步记 replayed、无失败步。
 *
 * 这一步验证的是「CLI 可用」而不是库内函数可用：
 * 进程真的退出后，token/房间/businessKey 只能从检查点恢复。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { startOthelloStubServer } from "../../src/demo/othello-server.js";

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve("src/cli.ts"), "playtest", ...args],
      {
        cwd: process.cwd(),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI 超时：${args.join(" ")}\n${stdout}\n${stderr}`));
    }, 60_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

test("真进程：崩溃 → 检查点 → CLI --resume 完成整局", async () => {
  const server = await startOthelloStubServer();
  mkdirSync(resolve("reports/checkpoints"), { recursive: true });
  const dir = mkdtempSync(resolve("reports/checkpoints/playtest-resume-"));
  const checkpointPath = join(dir, "crash.json");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GAME_BASE_URL: server.baseUrl,
    AI_API_BASE: "",
    AI_API_KEY: "",
    AI_MODEL: "",
  };

  try {
    const crashed = await runCli(
      [
        "--scenario=crash",
        "--seed=7",
        "--governance=in-memory",
        "--inject-crash=10",
        `--checkpoint=${checkpointPath}`,
      ],
      env,
    );
    assert.equal(
      crashed.code,
      3,
      `首次运行应因注入崩溃退出 3\n${crashed.stdout}\n${crashed.stderr}`,
    );
    assert.ok(existsSync(checkpointPath), "崩溃后必须留下检查点");

    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as {
      token: string;
      businessKey: string;
      nextStepNo: number;
      pending?: { stepNo: number; expectedAfterHash?: string };
    };
    assert.equal(checkpoint.nextStepNo, 10);
    assert.equal(checkpoint.pending?.stepNo, 10);
    assert.ok(checkpoint.pending?.expectedAfterHash, "检查点应含本地投影的 after 哈希");
    assert.ok(!crashed.stdout.includes(checkpoint.token), "stdout 不得泄漏对局凭证");

    const resumed = await runCli([`--governance=in-memory`, `--resume=${checkpointPath}`], env);
    assert.equal(resumed.code, 0, `续跑应成功退出 0\n${resumed.stdout}\n${resumed.stderr}`);
    assert.ok(!resumed.stdout.includes(checkpoint.token), "续跑 stdout 不得泄漏对局凭证");
    assert.equal(existsSync(checkpointPath), false, "正常收口后检查点应被清理");

    const reportMatch = /报告：(.+\.md)/.exec(resumed.stdout);
    assert.ok(reportMatch, `应打印报告路径：\n${resumed.stdout}`);
    const reportPath = reportMatch[1]!;
    const jsonPath = reportPath.replace(/\.md$/, ".json");
    const report = JSON.parse(readFileSync(jsonPath, "utf8")) as {
      businessKey: string;
      stepCount: number;
      replayedSteps: number;
      failedSteps: number;
      usage: { governance: number | null; synthetic: number | null; unavailableSteps: number };
      steps: { stepNo: number; outcome: string }[];
    };

    assert.equal(report.businessKey, checkpoint.businessKey, "续跑必须复用同一对局");
    assert.equal(report.failedSteps, 0, "续跑不应有失败步");
    assert.ok(report.replayedSteps >= 1, "pending 步应记为重放");
    assert.equal(report.steps[10]?.outcome, "replayed", "第 10 步应判定为重放");
    assert.ok(report.stepCount > 10, "续跑后应继续走完");
    assert.equal(report.usage.governance, null, "内存替身的合成值不能冒充真实治理成本");
    if (report.usage.synthetic === null) {
      assert.ok(report.usage.unavailableSteps > 0, "部分步骤无用量时必须显式计为 unavailable");
    } else {
      assert.ok(report.usage.synthetic > 0, "替身合成值只能落在 synthetic 口径");
    }

    rmSync(reportPath, { force: true });
    rmSync(jsonPath, { force: true });
    rmSync(reportPath.replace(/\.md$/, ".html"), { force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});
