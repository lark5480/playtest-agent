/**
 * 单测 · 种子化 PRNG
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createPrng, pickOne, randomInt, seedFrom, shuffle } from "../src/core/prng.js";

test("同 seed 得同序列", () => {
  const a = createPrng(42);
  const b = createPrng(42);
  for (let i = 0; i < 100; i++) {
    assert.equal(a(), b(), `第 ${i} 个随机数应一致`);
  }
});

test("异 seed 得异序列", () => {
  const a = createPrng(1);
  const b = createPrng(2);
  const seqA = Array.from({ length: 10 }, () => a());
  const seqB = Array.from({ length: 10 }, () => b());
  assert.notDeepEqual(seqA, seqB);
});

test("输出落在 [0,1)", () => {
  const prng = createPrng(7);
  for (let i = 0; i < 1000; i++) {
    const v = prng();
    assert.ok(v >= 0 && v < 1, `越界：${v}`);
  }
});

test("randomInt 落在 [0,max)", () => {
  const prng = createPrng(3);
  for (let i = 0; i < 1000; i++) {
    const v = randomInt(prng, 8);
    assert.ok(v >= 0 && v < 8, `越界：${v}`);
    assert.equal(Number.isInteger(v), true);
  }
});

test("randomInt(max=0) 返回 0 不抛错", () => {
  assert.equal(randomInt(createPrng(1), 0), 0);
});

test("pickOne 空数组返回 undefined", () => {
  assert.equal(pickOne(createPrng(1), []), undefined);
});

test("pickOne 同 seed 选同一元素", () => {
  const items = ["a", "b", "c", "d", "e"];
  assert.equal(pickOne(createPrng(99), items), pickOne(createPrng(99), items));
});

test("shuffle 不改原数组且同 seed 同结果", () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const out = shuffle(createPrng(5), items);
  assert.deepEqual(items, [1, 2, 3, 4, 5, 6, 7, 8], "原数组不得被修改");
  assert.deepEqual(out, shuffle(createPrng(5), items));
  assert.equal(out.length, items.length);
  assert.deepEqual(
    [...out].sort((a, b) => a - b),
    items,
    "洗牌后元素集合不变",
  );
});

test("seedFrom 对同串稳定，异串不同", () => {
  assert.equal(seedFrom("playtest"), seedFrom("playtest"));
  assert.notEqual(seedFrom("playtest"), seedFrom("playtes"));
});
