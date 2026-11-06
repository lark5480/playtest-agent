/**
 * 治理客户端 · 真实 aiwarden（HTTP）
 *
 * 对接 aiwarden 的既有边界，**不改它一个字节**：
 * `POST /api/v1/agent/tools/{tool}/invoke`
 *
 * 请求契约（`ToolInvokeRequest`）：
 *   businessKey · sessionId · stepNo · input
 * 响应契约（`ToolInvokeResponse`）：
 *   status(SUCCEEDED/FAILED/…) · result · error · idemKey · replayed
 *
 * 这与本项目的冻结契约 ⑦（幂等键 = businessKey + session + 步骤指纹）**同构**，
 * 因此替身与真实实现的行为可以对齐 —— 由治理契约测试套件保证。
 *
 * 身份：aiwarden 要求租户 + 主体双必填（`TenantContext` / `PrincipalContext`），
 * 通过 HTTP 头传递。本项目用环境变量注入，**不入日志**。
 */

import { canonicalize, computeFingerprint, fingerprintKey } from "../core/fingerprint.js";
import type {
  GovernanceClient,
  GovernanceResult,
  GovernanceUsage,
  GovernanceUsageEntry,
} from "../types/governance.js";

export interface AiwardenHttpOptions {
  /** aiwarden 基地址（默认本地 8080）。 */
  readonly baseUrl?: string;
  /**
   * 工具名（aiwarden 侧注册的工具）。
   *
   * aiwarden 当前注册的工具（源码核实）：`create_ticket` / `assign_ticket` / `export_data`。
   * **没有游戏动作工具** —— 见 ARCHITECTURE §6 的验证缺口记录。
   *
   * `create_ticket` 的语义是通用的（PRD §10：工单是零资金风险的演示替身）：
   * `orderRef` 参与唯一约束（幂等的最终防线），`title` 存载荷。
   * 因此它可以被当作"游戏动作"的替身来验证整条治理管道。
   */
  readonly tool?: string;
  /**
   * 租户标识（身份头）。
   *
   * **必须是数值字符串** —— aiwarden 的 `tenant_id` 是 `long`
   * （`TenantContext.requireTenantIdAsLong()` 对非数值直接拒绝，HTTP 400）。
   * 种子数据里是 `id=1, name=demo-tenant`。
   */
  readonly tenantId?: string;
  /** 主体标识（身份头）。 */
  readonly userId?: string;
  /**
   * 用量查询接口的主体标识。
   *
   * `/api/v1/admin/usage` 走 `PrincipalContext.requireUserIdAsLong()`，
   * **必须**是数值字符串；与工具调用入口的字符串主体分开配置。
   */
  readonly adminUserId?: string;
  /** 单次请求超时（毫秒）。 */
  readonly timeoutMs?: number;
  /** 用量异步落库的轮询次数。 */
  readonly usagePollAttempts?: number;
  /** 用量轮询间隔（毫秒）。 */
  readonly usagePollIntervalMs?: number;
}

export class AiwardenHttpClient implements GovernanceClient {
  readonly name = "aiwarden-http";

  private readonly baseUrl: string;
  private readonly tool: string;
  private readonly tenantId: string;
  private readonly userId: string;
  private readonly adminUserId: string;
  private readonly timeoutMs: number;
  private readonly usagePollAttempts: number;
  private readonly usagePollIntervalMs: number;

  public constructor(options: AiwardenHttpOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://localhost:8080").replace(/\/+$/, "");
    this.tool = options.tool ?? "create_ticket";
    this.tenantId = options.tenantId ?? process.env.AIWARDEN_TENANT_ID ?? "1";
    this.userId = options.userId ?? process.env.AIWARDEN_USER_ID ?? "playtest-agent";
    this.adminUserId = options.adminUserId ?? process.env.AIWARDEN_ADMIN_USER_ID ?? "1";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.usagePollAttempts = options.usagePollAttempts ?? 30;
    this.usagePollIntervalMs = options.usagePollIntervalMs ?? 300;
  }

  async invoke(params: {
    readonly businessKey: string;
    readonly session: string;
    readonly stepNo: number;
    readonly action: Readonly<Record<string, unknown>>;
    readonly perform: () => Promise<void>;
  }): Promise<GovernanceResult> {
    // 先向治理面申请执行 —— 由它决定是首见还是重放。
    // 注意：**副作用由本方法在治理允许后执行**，而非在请求体里传递，
    // 这样"治理拒绝"就真的不会产生副作用。
    const res = await this.post<ToolInvokeResponse>(
      `/api/v1/agent/tools/${encodeURIComponent(this.tool)}/invoke`,
      {
        businessKey: params.businessKey,
        sessionId: params.session,
        stepNo: params.stepNo,
        input: this.buildInput(params),
      },
    );

    // 成功白名单必须先于 replayed；失败终态重放不是执行许可。
    if (!res || res.status !== "SUCCEEDED") {
      throw new Error("治理未确认成功，禁止执行游戏动作");
    }
    if (typeof res.replayed !== "boolean") {
      throw new Error("治理响应缺少有效重放标记，禁止执行游戏动作");
    }

    if (res.replayed) {
      // 命中终态：未重复执行 → 副作用**不得**再发生
      return {
        businessKey: params.businessKey,
        replayed: true,
        ...(res.result?.["traceId"] ? { traceId: String(res.result["traceId"]) } : {}),
        tokenSource: "unavailable",
        tokensUnavailableReason: "单次工具调用响应不含成本，需按 session 查询用量",
      };
    }

    await params.perform();

    return {
      businessKey: params.businessKey,
      replayed: false,
      ...(res.result?.["traceId"] ? { traceId: String(res.result["traceId"]) } : {}),
      tokenSource: "unavailable",
      tokensUnavailableReason: "单次工具调用响应不含成本，需按 session 查询用量",
    };
  }

  /**
   * 按 session 查询 aiwarden 的用量明细。
   *
   * aiwarden 的计量走 Outbox → Kafka → `t_llm_call_log`，是异步的；
   * 因此做有限轮询。仍拿不到就显式 `unavailable`，**不填 0**。
   */
  async queryUsage(params: {
    readonly session: string;
    readonly expectedSteps?: readonly number[];
    readonly since?: number;
  }): Promise<GovernanceUsage> {
    let lastReason = "aiwarden usage 在该 session 暂无记录（可能尚未落库）";
    const expected = params.expectedSteps ?? [];

    for (let attempt = 0; attempt < this.usagePollAttempts; attempt += 1) {
      try {
        const rows = await this.getUsageRows(params.session, params.since);
        const byStep = aggregateUsage(rows);
        const missing = expected.filter(
          (stepNo) => !byStep.some((entry) => entry.stepNo === stepNo),
        );

        if (byStep.length > 0 && missing.length === 0) {
          return { source: "governance-usage", byStep };
        }
        if (byStep.length > 0 && missing.length > 0) {
          lastReason = `aiwarden usage 仍缺 ${missing.length} 步记录（${missing
            .slice(0, 8)
            .join(", ")}）`;
        }
        if (rows.length > 0 && byStep.length === 0) {
          lastReason = "aiwarden usage 记录缺少 stepNo，无法按步骤归因";
        }
      } catch {
        return {
          source: "unavailable",
          byStep: [],
          unavailableReason: "aiwarden usage 查询失败（网络或响应无效）",
        };
      }

      if (attempt < this.usagePollAttempts - 1) {
        await sleep(this.usagePollIntervalMs);
      }
    }

    return { source: "unavailable", byStep: [], unavailableReason: lastReason };
  }

  /**
   * 构造工具输入。
   *
   * `create_ticket` 的契约（源码核实）：`orderRef`（必填，参与 `uk_ticket_tenant_idem`
   * 唯一约束 —— 幂等的**最终防线**）+ `title`（必填，存载荷）。
   *
   * ⚠️ **`orderRef` 必须包含全部幂等维度**（businessKey + session + stepNo + 动作摘要）。
   * 起因：aiwarden 的 `create_ticket` 用 `orderRef` 做唯一约束，
   * 而本项目冻结契约 ③ 的 `digest` **只吃 `{stepNo, payload}`**（不含 businessKey/session）。
   * 若直接把 `digest` 当 `orderRef`，则「不同 session 的同一动作」会撞同一个 orderRef →
   * 被 `ON CONFLICT DO NOTHING` 吞掉 → **副作用静默丢失**（实测踩到，契约测试抓到）。
   *
   * 正确做法：`orderRef` = **完整**的幂等键（businessKey::session::stepNo::digest），
   * 它由 aiwarden 侧再哈希一次得到自己的 idemKey —— 两侧语义一致且互不干扰。
   */
  private buildInput(params: {
    readonly businessKey: string;
    readonly session: string;
    readonly stepNo: number;
    readonly action: Readonly<Record<string, unknown>>;
  }): Record<string, unknown> {
    const fingerprint = computeFingerprint({
      businessKey: params.businessKey,
      session: params.session,
      stepNo: params.stepNo,
      action: { id: "", payload: params.action },
    });
    return {
      orderRef: fingerprintKey(fingerprint).slice(0, 128),
      // ⚠️ title 必须用**规范化**后的内容，否则键序不同的同一语义动作会产生不同的
      // title → 不同的 idemKey → 治理面认不出重放（实测：契约「动作内容键序不同
      // 视为同一动作」在真实实现上失败）。
      //
      // aiwarden 侧只对顶层 Map 排序（`ORDER_MAP_ENTRIES_BY_KEYS`），
      // 所以**嵌套结构必须由本侧先规范化**，不能指望服务端。
      title: `playtest step ${params.stepNo}: ${JSON.stringify(canonicalize(params.action))}`.slice(
        0,
        250,
      ),
    };
  }

  private async getUsageRows(session: string, since?: number): Promise<readonly UsageRow[]> {
    const query = new URLSearchParams({
      sessionId: session,
      limit: "500",
    });
    // 同一个 scenario+seed 会复用 session key；用 run 起始时间隔离历史行，
    // 否则「查到了任意一条」会被上一轮的数据提前满足。
    if (since !== undefined) query.set("from", new Date(since).toISOString());
    const path = `/api/v1/admin/usage?${query.toString()}`;
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        "X-Aiwarden-Tenant-Id": this.tenantId,
        // 用量接口走 requireUserIdAsLong()，必须是数值主体。
        "X-Aiwarden-User-Id": this.adminUserId,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`aiwarden usage HTTP ${res.status}`);
    }
    const body = JSON.parse(text) as unknown;
    return Array.isArray(body) ? (body as UsageRow[]) : [];
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // aiwarden 的身份头（租户 + 主体双必填）。
          // 头名取自 aiwarden 源码常量，不是猜的：
          //   TenantContext.TENANT_ID_HEADER = "X-Aiwarden-Tenant-Id"
          //   PrincipalContext.USER_ID_HEADER  = "X-Aiwarden-User-Id"
          "X-Aiwarden-Tenant-Id": this.tenantId,
          "X-Aiwarden-User-Id": this.userId,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`aiwarden HTTP ${res.status}`);
      }
      return JSON.parse(text) as T;
    } catch {
      throw new Error("aiwarden 请求失败（网络、HTTP 或响应无效）");
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * aiwarden 的工具调用响应（对应 `ToolInvokeResponse`）。
 */
interface ToolInvokeResponse {
  readonly invocationId: number;
  readonly tool: string;
  readonly status: string;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
  readonly idemKey?: string;
  readonly replayed: boolean;
}

/**
 * aiwarden `/api/v1/admin/usage` 的条目。
 * 同时兼容 Jackson 默认 camelCase 与可能的 snake_case。
 */
interface UsageRow {
  readonly stepNo?: number;
  readonly step_no?: number;
  readonly tool?: string;
  readonly promptTokens?: number;
  readonly prompt_tokens?: number;
  readonly completionTokens?: number;
  readonly completion_tokens?: number;
}

function aggregateUsage(rows: readonly UsageRow[]): GovernanceUsageEntry[] {
  const byStep = new Map<number, { prompt: number; completion: number; tool: string }>();

  for (const row of rows) {
    const stepNo = row.stepNo ?? row.step_no;
    if (typeof stepNo !== "number" || !Number.isFinite(stepNo)) continue;
    const prompt = row.promptTokens ?? row.prompt_tokens ?? 0;
    const completion = row.completionTokens ?? row.completion_tokens ?? 0;
    const current = byStep.get(stepNo) ?? {
      prompt: 0,
      completion: 0,
      tool: row.tool ?? "aiwarden",
    };
    current.prompt += prompt;
    current.completion += completion;
    byStep.set(stepNo, current);
  }

  return [...byStep.entries()]
    .sort(([a], [b]) => a - b)
    .map(([stepNo, value]) => ({
      stepNo,
      promptTokens: value.prompt,
      completionTokens: value.completion,
      tool: value.tool,
    }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
