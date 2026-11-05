/**
 * 单测 · 检查点读写（原子写、校验、凭证保留）
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FileCheckpointStore, type Checkpoint } from "../src/driver/checkpoint.js";

function checkpoint(): Checkpoint {
  return {
    schemaVersion: 1,
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
    assert.ok(readFileSync(store.path, "utf8").includes('"schemaVersion": 1'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("检查点 schemaVersion 不匹配 → 显式拒绝", () => {
  const dir = mkdtempSync(join(tmpdir(), "playtest-ckpt-"));
  try {
    const store = new FileCheckpointStore(join(dir, "bad.json"));
    const bad = { ...checkpoint(), schemaVersion: 2 };
    store.save(bad as unknown as Checkpoint);
    assert.throws(() => store.read(), /schemaVersion/);
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
