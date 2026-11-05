/**
 * 单测 · 幂等指纹（地基冻结契约 ③）
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalize,
  computeFingerprint,
  digestOf,
  fingerprintKey,
} from "../src/core/fingerprint.js";

const action = (payload: Record<string, unknown>) => ({ id: "a1", payload });

test("同动作同指纹（键序无关）", () => {
  const a = computeFingerprint({
    businessKey: "room1",
    session: "s1",
    stepNo: 3,
    action: action({ row: 1, col: 2 }),
  });
  const b = computeFingerprint({
    businessKey: "room1",
    session: "s1",
    stepNo: 3,
    action: action({ col: 2, row: 1 }),
  });
  assert.equal(a.digest, b.digest, "键序不同不应改变指纹");
});

test("异动作异指纹", () => {
  const a = computeFingerprint({
    businessKey: "room1",
    session: "s1",
    stepNo: 3,
    action: action({ row: 1, col: 2 }),
  });
  const b = computeFingerprint({
    businessKey: "room1",
    session: "s1",
    stepNo: 3,
    action: action({ row: 1, col: 3 }),
  });
  assert.notEqual(a.digest, b.digest, "内容不同必须改变指纹");
});

test("异步骤号异指纹", () => {
  const a = computeFingerprint({
    businessKey: "room1",
    session: "s1",
    stepNo: 3,
    action: action({ row: 1 }),
  });
  const b = computeFingerprint({
    businessKey: "room1",
    session: "s1",
    stepNo: 4,
    action: action({ row: 1 }),
  });
  assert.notEqual(a.digest, b.digest, "步骤号不同必须改变指纹");
});

test("动作 id 不参与指纹（展示标识不该影响身份）", () => {
  const a = digestOf({ id: "x", payload: { row: 1 } }, 0);
  const b = digestOf({ id: "y", payload: { row: 1 } }, 0);
  assert.equal(a, b, "Action.id 不参与指纹");
});

test("数组顺序有语义：打乱即变指纹", () => {
  const a = digestOf({ id: "x", payload: { seq: [1, 2] } }, 0);
  const b = digestOf({ id: "x", payload: { seq: [2, 1] } }, 0);
  assert.notEqual(a, b, "数组顺序必须保留");
});

test("undefined 键被丢弃（与 JSON 序列化一致）", () => {
  const a = digestOf({ id: "x", payload: { row: 1, extra: undefined } }, 0);
  const b = digestOf({ id: "x", payload: { row: 1 } }, 0);
  assert.equal(a, b, "undefined 键不应影响指纹");
});

test("嵌套对象键序无关", () => {
  const a = digestOf({ id: "x", payload: { o: { z: 1, a: { y: 2, b: 3 } } } }, 0);
  const b = digestOf({ id: "x", payload: { o: { a: { b: 3, y: 2 }, z: 1 } } }, 0);
  assert.equal(a, b, "嵌套键序不应影响指纹");
});

test("NaN / Infinity 归一为 null（保证摘要可复现）", () => {
  const a = canonicalize({ x: Number.NaN });
  assert.deepEqual(a, { x: null });
});

test("digest 长度固定 32", () => {
  assert.equal(digestOf(action({ a: 1 }), 0).length, 32);
});

test("fingerprintKey 拼接稳定且可对照", () => {
  const fp = computeFingerprint({
    businessKey: "room1",
    session: "s1",
    stepNo: 2,
    action: action({ row: 1 }),
  });
  const key = fingerprintKey(fp);
  assert.ok(key.startsWith("room1::"));
  assert.ok(key.includes("::s1::"));
  assert.ok(key.includes("::2::"));
});
