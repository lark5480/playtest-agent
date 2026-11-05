/**
 * 单测 · CLI 参数解析与数值校验
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CliArgError, parseArgs, readInteger, readString } from "../src/cli-args.js";

test("解析子命令、等号取值与分离式取值", () => {
  const { command, options } = parseArgs([
    "playtest",
    "--",
    "--scenario",
    "crash",
    "--seed=42",
    "--inject-crash=10",
  ]);
  assert.equal(command, "playtest");
  assert.equal(options.get("scenario"), "crash");
  assert.equal(options.get("seed"), "42");
  assert.equal(options.get("inject-crash"), "10");
});

test("缺失取值的 flag 不吞掉下一个 flag", () => {
  const { options } = parseArgs(["playtest", "--checkpoint", "--resume=ckpt.json"]);
  assert.equal(options.get("checkpoint"), "");
  assert.equal(options.get("resume"), "ckpt.json");
});

test("--inject-crash 必须是 ≥0 的整数", () => {
  const { options } = parseArgs(["playtest", "--inject-crash=after-action"]);
  assert.throws(() => readInteger(options, "inject-crash", { min: 0 }), CliArgError);
  assert.throws(() => readInteger(options, "inject-crash", { min: 0 }), /必须是整数/);
});

test("--seed 允许负数，--max-steps 必须 ≥1", () => {
  const { options } = parseArgs(["playtest", "--seed=-1", "--max-steps=0"]);
  assert.equal(readInteger(options, "seed"), -1);
  assert.throws(() => readInteger(options, "max-steps", { min: 1 }), /必须 ≥ 1/);
});

test("readString 把空串视为缺省", () => {
  const { options } = parseArgs(["playtest", "--resume"]);
  assert.equal(readString(options, "resume"), undefined);
});
