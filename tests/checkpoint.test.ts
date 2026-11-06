/**
 * 单测 · 检查点读写（原子写、校验、凭证保留）
 */

import assert from "node:assert/strict";
import fs, {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FileCheckpointStore, type Checkpoint } from "../src/driver/checkpoint.js";

function checkpoint(): Checkpoint {
  return {
    schemaVersion: 2,
    initialState: { id: "ROOM1", status: "playing", turn: "black", legalActions: [], payload: {} },
    budget: { maxCalls: 3, attempts: [{ callId: 1, state: "in-flight" }] },
    scenario: "crash",
    seed: 42,
    adapter: "othello-local",
    governanceSource: "in-memory",
    session: "pt-crash-42",
    businessKey: "ROOM1",
    token: "SECRET-TOKEN",
    startedAt: 1,
    nextStepNo: 10,
    lastObservationSeq: 10,
    steps: [],
    findings: [],
    pending: {
      stepNo: 10,
      action: { id: "1,2", payload: { row: 1, col: 2 } },
      reason: "test",
      degraded: false,
      fingerprint: {
        businessKey: "ROOM1",
        session: "pt-crash-42",
        stepNo: 10,
        digest: "0123456789abcdef0123456789abcdef",
      },
      beforeObservation: {
        state: {
          id: "ROOM1",
          status: "playing",
          turn: "black",
          legalActions: [],
          payload: {},
        },
        seq: 10,
        at: 1,
      },
      beforeStateHash: "before",
      expectedAfterHash: "after",
    },
  };
}

test("检查点写入后可读回，凭证完整保留", () => {
  const dir = mkdtempSync(join(tmpdir(), "playtest-ckpt-"));
  try {
    const store = new FileCheckpointStore(join(dir, "nested", "crash.json"));
    store.save(checkpoint());
    const loaded = store.read();
    assert.equal(loaded.businessKey, "ROOM1");
    assert.equal(loaded.pending?.stepNo, 10);
    assert.equal(loaded.token, "SECRET-TOKEN");
    // 原子写不应留下临时文件
    assert.ok(readFileSync(store.path, "utf8").includes('"schemaVersion": 2'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("检查点 schemaVersion 不匹配 → 显式拒绝", () => {
  const dir = mkdtempSync(join(tmpdir(), "playtest-ckpt-"));
  try {
    const store = new FileCheckpointStore(join(dir, "bad.json"));
    const bad = { ...checkpoint(), schemaVersion: 1 };
    store.save(bad as unknown as Checkpoint);
    assert.throws(() => store.read(), /schemaVersion/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("活动写者拒绝并发，release 后可重新获取", () => {
  const dir = mkdtempSync(join(tmpdir(), "playtest-lock-"));
  try {
    const first = new FileCheckpointStore(join(dir, "run.json"));
    const second = new FileCheckpointStore(first.path);
    first.acquire();
    assert.throws(() => second.acquire(), /活动写者/);
    assert.throws(() => first.acquire(), /持有锁/);
    first.save(checkpoint());
    first.release();
    second.acquire();
    assert.deepEqual(second.read().budget, checkpoint().budget);
    second.release();
    assert.equal(existsSync(`${first.path}.lock`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("崩溃遗留锁仅在 PID 确认退出后回收", () => {
  const dir = mkdtempSync(join(tmpdir(), "playtest-lock-"));
  try {
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    assert.equal(child.status, 0);
    assert.throws(
      () => process.kill(child.pid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
    const store = new FileCheckpointStore(join(dir, "run.json"));
    writeFileSync(`${store.path}.lock`, JSON.stringify({ pid: child.pid, owner: "crashed" }));
    store.acquire();
    store.release();
    assert.equal(existsSync(`${store.path}.lock`), false);
    writeFileSync(`${store.path}.lock`, "broken lock");
    assert.throws(() => store.acquire(), /无法确认/);
    assert.equal(readFileSync(`${store.path}.lock`, "utf8"), "broken lock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows rename EPERM 不删除旧检查点，也不遗留含凭证临时文件", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "playtest-rename-"));
  try {
    const store = new FileCheckpointStore(join(dir, "run.json"));
    store.save(checkpoint());
    const original = readFileSync(store.path, "utf8");
    t.mock.method(fs, "renameSync", () => {
      throw Object.assign(new Error("blocked"), { code: "EPERM" });
    });
    syncBuiltinESMExports();
    assert.throws(() => store.save({ ...checkpoint(), nextStepNo: 11 }), /上一有效文件已保留/);
    assert.equal(readFileSync(store.path, "utf8"), original);
    assert.deepEqual(readdirSync(dir), ["run.json"]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v2 缺 initialState 或损坏预算必须拒绝", () => {
  const dir = mkdtempSync(join(tmpdir(), "playtest-validate-"));
  try {
    const store = new FileCheckpointStore(join(dir, "run.json"));
    for (const bad of [
      { ...checkpoint(), initialState: undefined },
      { ...checkpoint(), budget: { maxCalls: 1, attempts: [{ callId: 1, state: "settled" }] } },
      { ...checkpoint(), budget: { maxCalls: 1, attempts: [{ callId: 2, state: "in-flight" }] } },
    ]) {
      store.save(bad as unknown as Checkpoint);
      assert.throws(() => store.read());
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("检查点不存在 → 显式报错", () => {
  const dir = mkdtempSync(join(tmpdir(), "playtest-ckpt-"));
  try {
    const store = new FileCheckpointStore(join(dir, "missing.json"));
    assert.throws(() => store.read(), /不存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
