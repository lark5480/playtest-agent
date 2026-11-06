import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeReport, defaultBaseName } from "../src/report/report-writer.js";
import { parseReportJson } from "../src/core/recording.js";
import { faultyReport } from "./helpers/report-fixtures.js";

test("落盘三种格式都只含v2白名单数据，移除凭证与原始错误", () => {
  const dir = mkdtempSync(join(tmpdir(), "playtest-report-v2-"));
  try {
    const raw = JSON.parse(JSON.stringify(faultyReport()));
    raw.token = "SECRET_TOKEN";
    raw.metadata.token = "SECRET_TOKEN";
    raw.steps[0].error = "SECRET_TOKEN";
    raw.findings[0].message = "SECRET_TOKEN";
    const paths = writeReport(raw, { dir, baseName: "test" });
    assert.deepEqual(readdirSync(dir).sort(), ["test.html", "test.json", "test.md"]);
    for (const path of Object.values(paths))
      assert.ok(!readFileSync(path, "utf8").includes("SECRET_TOKEN"));
    const report = parseReportJson(JSON.parse(readFileSync(paths.json, "utf8")));
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.status, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("无效报告在创建任何报告文件前失败，路径不能逃离报告目录", () => {
  const dir = mkdtempSync(join(tmpdir(), "playtest-report-v2-"));
  try {
    for (const baseName of ["../escape", "sub/file", "..\\escape", "", ".", "..", "bad:name"]) {
      assert.throws(() => writeReport(faultyReport(), { dir, baseName }));
      assert.deepEqual(readdirSync(dir), []);
    }
    const raw = JSON.parse(JSON.stringify(faultyReport()));
    raw.schemaVersion = 1;
    assert.throws(() => writeReport(raw, { dir }), /不支持报告 v1/);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("默认文件名剔除路径和Windows非法字符", () => {
  assert.ok(!/[\\/:<>?*|]/.test(defaultBaseName("../<bad>/name", 1)));
});
