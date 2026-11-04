/**
 * 集成测试 · 真实 aiwarden 治理链路
 *
 * 验证"替身与真实实现行为等价"这条最重要的红线。
 *
 * 做法：真实 aiwarden 的 HTTP 客户端跑**同一套**治理契约测试
 * （`tests/contract/governance.contract.ts`）。
 *
 * 前置：aiwarden 需在 localhost:8080 运行，且已注册名为
 * `playtest.game.action` 的工具。不满足则**跳过**并说明原因 ——
 * 绝不"假装通过"。
 *
 * 注意：本项目对 aiwarden **零改动**，因此这里只验证**已存在**的边界；
 * 若 aiwarden 侧没有注册对应工具，契约套件中的"首次调用执行副作用"
 * 一条会失败 —— 那说明工具名需要对齐，而不是把断言改松。
 */

import { AiwardenHttpClient } from "../../src/governance/aiwarden-client.js";
import { registerGovernanceContractFiltered } from "../contract/governance.contract.js";
import { integrationGate } from "../helpers/integration-gate.js";

const BASE_URL = process.env.AIWARDEN_BASE_URL ?? "http://localhost:8080";
const TOOL = process.env.AIWARDEN_TOOL ?? "create_ticket";
/**
 * 租户标识必须是**数值字符串** —— aiwarden 的 `tenant_id` 是 `long`
 * （`TenantContext.requireTenantIdAsLong()` 对非数值直接拒绝，HTTP 400）。
 * 种子数据：`id=1, name=demo-tenant`。
 */
const TENANT_ID = process.env.AIWARDEN_TENANT_ID ?? "1";
const USER_ID = process.env.AIWARDEN_USER_ID ?? "playtest-agent";

async function aiwardenAvailable(): Promise<{ ok: boolean; reason: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${BASE_URL}/api/v1/agent/tools`, {
        headers: {
          "X-Aiwarden-Tenant-Id": TENANT_ID,
          "X-Aiwarden-User-Id": USER_ID,
        },
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, reason: `aiwarden 返回 HTTP ${res.status}` };
      const body = (await res.json()) as { tools?: string[] };
      const names = body.tools ?? [];
      if (!names.includes(TOOL)) {
        return {
          ok: false,
          reason: `aiwarden 可达，但未注册工具 "${TOOL}"（已注册：${names.join(", ") || "无"}）`,
        };
      }
      return { ok: true, reason: "" };
    } finally {
      clearTimeout(timer);
    }
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

// 真实客户端：工具名与契约套件里的调用保持一致。
const createClient = () =>
  new AiwardenHttpClient({
    baseUrl: BASE_URL,
    tool: TOOL,
    tenantId: TENANT_ID,
    userId: USER_ID,
  });

// 真实实现不返回 traceId（它属于 session 层）→ 那条用例标记为不适用。
registerGovernanceContractFiltered(createClient, "真实 aiwarden 契约", {
  includeInMemoryOnly: false,
  skip: gate.skip,
  precheck: gate.precheck,
});
