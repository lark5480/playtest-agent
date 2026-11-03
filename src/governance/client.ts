/**
 * 治理客户端契约（地基冻结契约 ⑦）
 *
 * 实现方有两种：
 * 1. `AiwardenHttpClient` —— 对接真实 aiwarden（进程外，零改动）；
 * 2. `InMemoryGovernanceClient` —— 内存替身，用于单测 / 契约测试 / 本机无 Docker 时。
 *
 * 二者**行为必须一致**，由 `tests/contract/governance.contract.test.ts` 保证。
 * 这是本项目最重要的红线之一：**替身与真实实现不得有行为差异**，
 * 否则"测试全绿"不代表真实链路成立（违反 AGENTS §4 的"不报错、只是静默不生效"坑形态）。
 */

import { canonicalize } from "../core/fingerprint.js";

import type { GovernanceClient, GovernanceResult } from "../types/governance.js";

/**
 * 内存治理替身。
 *
 * 复刻 aiwarden 的 P3 幂等语义：
 * - 首次调用 → 执行副作用，记入终态，返回 `replayed: false`；
 * - 同键重复调用 → **不执行副作用**，返回 `replayed: true`。
 *
 * **键的构成**（对齐冻结契约 ⑦ 与 aiwarden ADR-013 决策 6）：
 * `businessKey + session + stepNo + 动作内容摘要`。
 * 动作内容**必须**参与 —— 否则"同一位置的不同动作"会被误判为重放而漏执行。
 */
export class InMemoryGovernanceClient implements GovernanceClient {
  readonly name = "in-memory";

  /** 已完成的调用（键 → 终态）。 */
  private readonly done = new Map<string, { readonly tokens: number; readonly traceId: string }>();

  /** 副作用实际执行次数（用于断言"重放没有第二次副作用"）。 */
  public performCount = 0;

  /** 令牌消耗（替身按固定值计，便于断言成本归因链路通）。 */
  public constructor(private readonly tokensPerCall = 10) {}

  async invoke(params: {
    readonly businessKey: string;
    readonly session: string;
    readonly stepNo: number;
    readonly action: Readonly<Record<string, unknown>>;
    readonly perform: () => Promise<void>;
  }): Promise<GovernanceResult> {
    const key = this.keyOf(params);
    const existing = this.done.get(key);
    if (existing) {
      return {
        businessKey: params.businessKey,
        replayed: true,
        traceId: existing.traceId,
        tokens: existing.tokens,
      };
    }

    await params.perform();
    this.performCount += 1;

    const traceId = `trace-${params.businessKey}-${params.stepNo}`;
    const tokens = this.tokensPerCall;
    this.done.set(key, { tokens, traceId });
    return {
      businessKey: params.businessKey,
      replayed: false,
      traceId,
      tokens,
    };
  }

  /**
   * 幂等键：businessKey + session + stepNo + 动作内容摘要。
   *
   * 动作内容用 `canonicalize` 归一（键序无关），保证语义相同的动作命中同一键。
   */
  private keyOf(params: {
    readonly businessKey: string;
    readonly session: string;
    readonly stepNo: number;
    readonly action: Readonly<Record<string, unknown>>;
  }): string {
    const actionJson = JSON.stringify(canonicalize(params.action));
    return [params.businessKey, params.session, String(params.stepNo), actionJson].join("::");
  }
}
