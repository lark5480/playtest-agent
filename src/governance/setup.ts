/**
 * 治理客户端 · 降级选择器
 *
 * 真实 aiwarden 不可达时（Docker 未起 / 服务未部署 / 网络不通），
 * 退到内存替身继续跑完场景 —— 但**必须显式告知**。
 *
 * 这条对应承诺 C4 的精神：**AI / 治理能力不可用时，游戏侧的验证不中断，
 * 但报告里必须如实说明"这段是在降级条件下跑的"**。
 *
 * 绝不静默：若用了替身，报告的治理来源标注为 "in-memory（降级）"。
 */

import { AiwardenHttpClient } from "./aiwarden-client.js";
import { InMemoryGovernanceClient } from "./client.js";
import type { GovernanceClient } from "../types/governance.js";

export interface GovernanceSetup {
  /** 实际使用的治理客户端。 */
  readonly client: GovernanceClient;
  /** 是否走了降级。 */
  readonly degraded: boolean;
  /** 降级原因（降级时非空）。 */
  readonly reason?: string;
}

/**
 * 探测 aiwarden 是否可达；可达则用真实客户端，否则降级到内存替身。
 */
export async function setupGovernance(options: {
  readonly baseUrl?: string;
  /** 强制降级（用于本地无 Docker 的开发）。 */
  readonly forceInMemory?: boolean;
  /** 探测超时（毫秒）。 */
  readonly probeTimeoutMs?: number;
}): Promise<GovernanceSetup> {
  if (options.forceInMemory) {
    return {
      client: new InMemoryGovernanceClient(),
      degraded: true,
      reason: "按要求强制使用内存治理替身（--governance=in-memory）",
    };
  }

  const client = new AiwardenHttpClient(options.baseUrl ? { baseUrl: options.baseUrl } : {});

  try {
    // 探活：列出可用工具（GET /api/v1/agent/tools）。
    // 这是一次**只读**调用，不产生副作用。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.probeTimeoutMs ?? 3000);
    try {
      const res = await fetch(
        `${(options.baseUrl ?? "http://localhost:8080").replace(/\/+$/, "")}/api/v1/agent/tools`,
        {
          headers: {
            "X-Aiwarden-Tenant-Id": process.env.AIWARDEN_TENANT_ID ?? "playtest",
            "X-Aiwarden-User-Id": process.env.AIWARDEN_USER_ID ?? "playtest-agent",
          },
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
    } finally {
      clearTimeout(timer);
    }

    return { client, degraded: false };
  } catch (error) {
    return {
      client: new InMemoryGovernanceClient(),
      degraded: true,
      reason: `aiwarden 不可达（${error instanceof Error ? error.message : String(error)}），已降级到内存治理替身`,
    };
  }
}
