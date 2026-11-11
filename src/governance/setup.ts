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
 *
 * 探活不仅查可达，还校验**目标工具已注册**（裁决 37）：只看 res.ok 的话，
 * 工具没注册会选中真实客户端然后每步 403 —— 那应该在探活时就降级。
 */

import { AiwardenHttpClient } from "./aiwarden-client.js";
import { InMemoryGovernanceClient } from "./client.js";
import { GovernanceContractError, GovernanceHttpError } from "./errors.js";
import type { GovernanceClient, GovernanceDegradedReasonCode } from "../types/governance.js";

export interface GovernanceSetup {
  /** 实际使用的治理客户端。 */
  readonly client: GovernanceClient;
  /** 是否走了降级。 */
  readonly degraded: boolean;
  /** 降级原因码（降级时非空）。 */
  readonly reason?: GovernanceDegradedReasonCode;
}

/**
 * 探测 aiwarden 是否可达且目标工具已注册；满足则用真实客户端，否则降级到内存替身。
 * 默认地址 / 身份头 / env 兜底全部复用客户端（单一事实源，不再各写一份）。
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
      reason: "forced-in-memory",
    };
  }

  const client = new AiwardenHttpClient(options.baseUrl ? { baseUrl: options.baseUrl } : {});

  try {
    // 探活：列出可用工具（GET /api/v1/agent/tools）。
    // 这是一次**只读**调用，不产生副作用。
    const tools = await client.listTools(options.probeTimeoutMs ?? 3000);
    if (!tools.includes(client.toolName)) {
      return {
        client: new InMemoryGovernanceClient(),
        degraded: true,
        reason: "tool-not-registered",
      };
    }
    return { client, degraded: false };
  } catch (error) {
    const reason: GovernanceDegradedReasonCode =
      error instanceof GovernanceHttpError
        ? "http-error"
        : error instanceof GovernanceContractError
          ? "unknown"
          : "unreachable";
    return {
      client: new InMemoryGovernanceClient(),
      degraded: true,
      reason,
    };
  }
}
