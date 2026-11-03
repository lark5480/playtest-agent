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

import { canonicalize } from "../core/fingerprint.js";
import type { GovernanceClient, GovernanceResult } from "../types/governance.js";

export interface AiwardenHttpOptions {
  /** aiwarden 基地址（默认本地 8080）。 */
  readonly baseUrl?: string;
  /** 工具名（aiwarden 侧注册的工具；未注册会被治理拒绝）。 */
  readonly tool?: string;
  /** 租户标识（身份头）。 */
  readonly tenantId?: string;
  /** 主体标识（身份头）。 */
  readonly userId?: string;
  /** 单次请求超时（毫秒）。 */
  readonly timeoutMs?: number;
}

export class AiwardenHttpClient implements GovernanceClient {
  readonly name = "aiwarden-http";

  private readonly baseUrl: string;
  private readonly tool: string;
  private readonly tenantId: string;
  private readonly userId: string;
  private readonly timeoutMs: number;

  public constructor(options: AiwardenHttpOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://localhost:8080").replace(/\/+$/, "");
    this.tool = options.tool ?? "playtest.game.action";
    this.tenantId = options.tenantId ?? process.env.AIWARDEN_TENANT_ID ?? "playtest";
    this.userId = options.userId ?? process.env.AIWARDEN_USER_ID ?? "playtest-agent";
    this.timeoutMs = options.timeoutMs ?? 30_000;
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
        input: { action: canonicalize(params.action) },
      },
    );

    if (res.replayed) {
      // 命中终态：未重复执行 → 副作用**不得**再发生
      return {
        businessKey: params.businessKey,
        replayed: true,
        ...(res.result?.["traceId"] ? { traceId: String(res.result["traceId"]) } : {}),
      };
    }

    if (res.status === "PENDING_APPROVAL" || res.status === "REJECTED") {
      throw new Error(`治理拒绝工具调用：status=${res.status} ${res.error ?? ""}`);
    }

    await params.perform();

    return {
      businessKey: params.businessKey,
      replayed: false,
      ...(res.result?.["traceId"] ? { traceId: String(res.result["traceId"]) } : {}),
    };
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
        throw new Error(`aiwarden ${path} → HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      return JSON.parse(text) as T;
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
