/**
 * 共享类型 · 治理（地基冻结契约 ⑦ 的载体）
 *
 * 本项目**不改 aiwarden**，只通过它既有的 HTTP / MCP 边界消费治理能力：
 * 幂等调用、成本归因、租约独占、检查点续跑。
 * 这里定义的是"从外部看治理能力长什么样"，与 aiwarden 的内部模型解耦。
 */

/**
 * 一次治理调用结果。
 */
export interface GovernanceResult {
  /** 调用的业务键（与幂等键构成对应）。 */
  readonly businessKey: string;
  /** 是否命中已有终态（true = 未重复产生副作用）。 */
  readonly replayed: boolean;
  /** 治理侧 traceId。 */
  readonly traceId?: string;
  /** 本次调用消耗的 token 数。 */
  readonly tokens?: number;
  /** token 数的来源口径。 */
  readonly tokenSource?: "model-usage" | "governance-usage" | "synthetic" | "unavailable";
  /** 未取得成本时的显式原因。 */
  readonly tokensUnavailableReason?: string;
  /** 治理拒绝原因（被拒绝时）。 */
  readonly deniedReason?: string;
}

/** 治理侧按步骤汇总的用量。 */
export interface GovernanceUsageEntry {
  readonly stepNo: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly tool: string;
}

/** 治理侧的 session 用量查询结果。 */
export interface GovernanceUsage {
  readonly source: "governance-usage" | "synthetic" | "unavailable";
  readonly byStep: readonly GovernanceUsageEntry[];
  /** source 为 unavailable 时必填，说明为什么拿不到。 */
  readonly unavailableReason?: string;
}

/**
 * 治理客户端契约。
 *
 * 实现方可以是 aiwarden 的 HTTP 适配器，也可以是测试用的内存替身
 * （`InMemoryGovernanceClient`）—— 二者行为必须一致，故由契约测试套件保证。
 */
export interface GovernanceClient {
  /** 客户端标识（写进报告，便于区分数据来源）。 */
  readonly name: string;

  /**
   * 执行一次受治理的调用。
   *
   * **幂等语义**：相同 `businessKey` 重复调用必须返回 `replayed: true`
   * 且**不产生第二次副作用**（对齐 aiwarden ADR-013 决策 6）。
   */
  invoke(params: {
    /** 业务键（对局标识）。 */
    readonly businessKey: string;
    /** 运行标识（session key）。 */
    readonly session: string;
    /** 步骤序号。 */
    readonly stepNo: number;
    /** 动作内容（参与指纹计算）。 */
    readonly action: Readonly<Record<string, unknown>>;
    /** 真正的副作用执行（由适配器提供；治理层只做记账与裁决）。 */
    readonly perform: () => Promise<void>;
  }): Promise<GovernanceResult>;

  /**
   * 按 session 查询治理侧成本明细。
   *
   * 真实 aiwarden 的用量是异步落库的，实现方应做有限轮询；
   * 传入 `expectedSteps` 时应轮询到这些步都出现（或超时），
   * 拿不到时返回 `source: "unavailable"`，**不得用 0 冒充**。
   */
  queryUsage?(params: {
    readonly session: string;
    readonly expectedSteps?: readonly number[];
    /** 只统计该时间点之后的用量（毫秒时间戳）；用于隔离同 session 的历史运行。 */
    readonly since?: number;
  }): Promise<GovernanceUsage>;

  /**
   * 从最近检查点续跑。
   *
   * 返回 null 表示"没有可续跑的运行"（首次执行时正常如此）。
   */
  resume?(params: {
    readonly businessKey: string;
    readonly session: string;
  }): Promise<{ readonly lastStepNo: number; readonly traceId?: string } | null>;
}
