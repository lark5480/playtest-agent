import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { runCli } from "../helpers/run-cli.js";
import { startFixtureProcess } from "../helpers/fixture-process.js";

async function modelServer(hang = false) {
  let calls = 0;
  let notify: () => void = () => {};
  const requested = new Promise<void>((done) => {
    notify = done;
  });
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += String(chunk);
    calls++;
    notify();
    if (hang) return;
    const body = JSON.parse(text) as { messages: { content: string }[] };
    const prompt = body.messages.map((message) => message.content).join("\n");
    const id = /^- ([^\s]+) ->/m.exec(prompt)?.[1] ?? "2,3";
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ choices: [{ message: { content: id } }], usage: { total_tokens: 3 } }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    requested,
    calls: () => calls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

function makeDir() {
  mkdirSync(resolve("reports/checkpoints"), { recursive: true });
  return mkdtempSync(resolve("reports/checkpoints/budget-test-"));
}

test("CLI预算停止及再次resume不重置额度，不额外发模型请求", async () => {
  const game = await startFixtureProcess(false);
  const model = await modelServer();
  const dir = makeDir();
  const path = join(dir, "state.json");
  const env = {
    AI_API_BASE: model.baseUrl,
    AI_API_KEY: "api-key-marker",
    AI_MODEL: "fake",
    AI_TIMEOUT_MS: "1000",
  };
  try {
    const first = await runCli(
      "playtest",
      [
        `--game-url=${game.baseUrl}`,
        "--governance=in-memory",
        "--strategy=llm",
        "--max-steps=10",
        "--max-model-calls=2",
        `--checkpoint=${path}`,
        `--report-dir=${dir}`,
      ],
      env,
    );
    assert.equal(first.code, 5, first.stdout + first.stderr);
    assert.equal(model.calls(), 2);
    const snapshot = JSON.parse(readFileSync(path, "utf8")) as {
      schemaVersion: number;
      budget: { attempts: { state: string }[] };
    };
    assert.equal(snapshot.schemaVersion, 2);
    assert.equal(snapshot.budget.attempts.length, 2);
    const resumed = await runCli(
      "playtest",
      [
        `--resume=${path}`,
        `--game-url=${game.baseUrl}`,
        "--governance=in-memory",
        `--report-dir=${dir}`,
      ],
      env,
    );
    assert.equal(resumed.code, 5, resumed.stdout + resumed.stderr);
    assert.equal(model.calls(), 2);
    assert.doesNotMatch(
      first.stdout + first.stderr + resumed.stdout + resumed.stderr,
      /api-key-marker/,
    );
  } finally {
    await model.close();
    await game.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("进程在模型响应前被终止：持久化in-flight，恢复后不退款不重发", async () => {
  const game = await startFixtureProcess(false);
  const model = await modelServer(true);
  const dir = makeDir();
  const path = join(dir, "inflight.json");
  const env = {
    ...process.env,
    AI_API_BASE: model.baseUrl,
    AI_API_KEY: "api-key-marker",
    AI_MODEL: "fake",
    AI_TIMEOUT_MS: "10000",
  };
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve("src/cli.ts"),
      "playtest",
      `--game-url=${game.baseUrl}`,
      "--governance=in-memory",
      "--max-model-calls=3",
      `--checkpoint=${path}`,
      `--report-dir=${dir}`,
    ],
    { env, stdio: "ignore" },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      model.requested,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("未收到模型请求")), 10000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    const before = JSON.parse(readFileSync(path, "utf8")) as {
      budget: { attempts: { state: string }[] };
    };
    assert.equal(before.budget.attempts[0]?.state, "in-flight");
    const exited = once(child, "exit");
    child.kill();
    await exited;
    const resumed = await runCli(
      "playtest",
      [
        `--resume=${path}`,
        `--game-url=${game.baseUrl}`,
        "--governance=in-memory",
        `--report-dir=${dir}`,
      ],
      env,
    );
    assert.equal(resumed.code, 5, resumed.stdout + resumed.stderr);
    assert.equal(model.calls(), 1);
    const after = JSON.parse(readFileSync(path, "utf8")) as {
      budget: { attempts: { state: string }[] };
    };
    assert.equal(after.budget.attempts[0]?.state, "unknown");
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await model.close();
    await game.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
