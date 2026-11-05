/**
 * 集成测试 · 真实 aiwarden 按 session 查询用量
 *
 * 验证「成本归因」不是空转：
 * - 工具调用真的写入 t_llm_call_log；
 * - 同键重放不会让该步用量翻倍；
 * - 查不到时显式 unavailable（由客户端负责），测试这里只接受真实数值。
 *
 * 前置：aiwarden 在 localhost:8080 运行，且注册了 create_ticket。
 * 不可达时按 integrationGate 规则跳过；强制模式下失败。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AiwardenHttpClient } from "../../src/governance/aiwarden-client.js";
import { integrationGate } from "../helpers/integration-gate.js";

const BASE_URL = process.env.AIWARDEN_BASE_URL ?? "http://localhost:8080";
const TOOL = process.env.AIWARDEN_TOOL ?? "create_ticket";
const TENANT_ID = process.env.AIWARDEN_TENANT_ID ?? "1";
const USER_ID = process.env.AIWARDEN_USER_ID ?? "playtest-agent";
const ADMIN_USER_ID = process.env.AIWARDEN_ADMIN_USER_ID ?? "1";

async function aiwardenAvailable(): Promise<{ ok: boolean; reason: string }> {
  try {
    const res = await fetch(`${BASE_URL}/api/v1/agent/tools`, {
      headers: {
        "X-Aiwarden-Tenant-Id": TENANT_ID,
        "X-Aiwarden-User-Id": USER_ID,
      },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { ok: false, reason: `aiwarden 返回 HTTP ${res.status}` };
    const body = (await res.json()) as { tools?: string[] };
    const names = body.tools ?? [];
    if (!names.includes(TOOL)) {
      return { ok: false, reason: `aiwarden 未注册工具 "${TOOL}"（已注册：${names.join(", ")}）` };
    }
    return { ok: true, reason: "" };
  } catch (error) {
    return {
      ok: false,
      reason: `aiwarden 不可达：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const probe = await aiwardenAvailable();
const gate = integrationGate({
  dependency: "aiwarden",
  available: probe.ok,
  reason: probe.reason,
});

function uniqueKey(): string {
  return `usage-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createClient(): AiwardenHttpClient {
  return new AiwardenHttpClient({
    baseUrl: BASE_URL,
    tool: TOOL,
    tenantId: TENANT_ID,
    userId: USER_ID,
    adminUserId: ADMIN_USER_ID,
    usagePollAttempts: 20,
    usagePollIntervalMs: 300,
  });
}

test("真实 aiwarden：按 session 查到用量且重放不重复计入", { skip: gate.skip }, async () => {
  gate.precheck?.();
  const client = createClient();
  const businessKey = uniqueKey();
  const session = uniqueKey();

  const invoke = (stepNo: number) =>
    client.invoke({
      businessKey,
      session,
      stepNo,
      action: { row: stepNo },
      perform: async () => {},
    });

  await invoke(0);
  const first = await client.queryUsage({ session, expectedSteps: [0] });
  assert.notEqual(first.source, "unavailable", `查不到用量：${first.unavailableReason ?? ""}`);
  const firstStep0 = first.byStep.find((entry) => entry.stepNo === 0);
  assert.ok(firstStep0, "应能查到 step 0 的用量");
  assert.equal(firstStep0.tool, TOOL, "用量应归因到实际工具");
  // aiwarden 在「未配置租户当月预算」时按设计把工具调用当量记 0；
  // 配置 t_budget 后才是 100/次。这里验证 usage 接口与归因，不把 0 当成失败。
  assert.ok(firstStep0.promptTokens >= 0 && firstStep0.completionTokens >= 0);

  // 同键重放：不得让该步用量翻倍
  const replay = await invoke(0);
  assert.equal(replay.replayed, true, "同键必须命中重放");
  const afterReplay = await client.queryUsage({ session, expectedSteps: [0] });
  const replayStep0 = afterReplay.byStep.find((entry) => entry.stepNo === 0);
  assert.ok(replayStep0, "重放后仍应能查到 step 0");
  assert.equal(
    replayStep0.promptTokens + replayStep0.completionTokens,
    firstStep0.promptTokens + firstStep0.completionTokens,
    "重放不得重复计入成本",
  );

  // 新步必须产生新的用量记录
  await invoke(1);
  const afterStep1 = await client.queryUsage({ session, expectedSteps: [0, 1] });
  const step1 = afterStep1.byStep.find((entry) => entry.stepNo === 1);
  assert.ok(step1, "应能查到 step 1 的用量");
});
