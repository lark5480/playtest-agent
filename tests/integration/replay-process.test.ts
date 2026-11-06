import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseReportJson } from "../../src/core/recording.js";
import { runCli } from "../helpers/run-cli.js";
import { startFixtureProcess } from "../helpers/fixture-process.js";

test("CLI进程结束后：新服务新进程复现预置缺陷，健康服务仅验证目标前缀", async () => {
  const dir = mkdtempSync(join(tmpdir(), "playtest-replay-"));
  try {
    const demo = await runCli("demo", [`--report-dir=${dir}`]);
    assert.equal(demo.code, 0, demo.stdout + demo.stderr);
    const summaryFile = readdirSync(dir).find(
      (name) => name.startsWith("demo-summary-") && name.endsWith(".json"),
    );
    assert.ok(summaryFile);
    const summary = JSON.parse(readFileSync(join(dir, summaryFile), "utf8")) as {
      passed: boolean;
      before: string;
    };
    assert.equal(summary.passed, true);
    const recording = parseReportJson(JSON.parse(readFileSync(summary.before, "utf8")));
    assert.equal(recording.metadata.source, "injected-fixture");
    assert.ok(recording.findings.some((f) => f.code === "OTH2-board-projection-mismatch"));
    for (const healthy of [false, true]) {
      const service = await startFixtureProcess(!healthy);
      try {
        const replay = await runCli("replay", [
          `--file=${summary.before}`,
          `--game-url=${service.baseUrl}`,
          `--report-dir=${dir}`,
        ]);
        assert.equal(replay.code, healthy ? 4 : 0, replay.stdout + replay.stderr);
        assert.match(replay.stdout, healthy ? /not-reproduced/ : /reproduced/);
        assert.doesNotMatch(replay.stdout + replay.stderr, /black-42|white-42|api-key-marker/);
      } finally {
        await service.close();
      }
    }
    const old = join(dir, "old.json");
    writeFileSync(old, JSON.stringify({ schemaVersion: 1 }));
    const rejected = await runCli("replay", [`--file=${old}`, "--game-url=http://127.0.0.1:1"]);
    assert.equal(rejected.code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replay拒绝隐含/远程目标，不会用报告中地址主动访问服务", async () => {
  const dir = mkdtempSync(join(tmpdir(), "playtest-target-"));
  try {
    const demo = await runCli("demo", [`--report-dir=${dir}`]);
    assert.equal(demo.code, 0, demo.stdout + demo.stderr);
    const before = readdirSync(dir).find(
      (name) => name.startsWith("demo-before-") && name.endsWith(".json"),
    );
    assert.ok(before);
    const result = await runCli("replay", [`--file=${join(dir, before)}`]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /显式/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
