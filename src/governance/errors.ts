/**
 * 治理客户端错误分类（裁决 37）。
 *
 * 全部继承 Error；**消息不含响应体**（凭证纪律，契约矩阵断言 SECRET-TOKEN 不泄露）。
 * 报告层只落闭合原因码（裁决 35），这些类型只用于进程内分类与差异化恢复。
 */

/** 非 2xx HTTP 响应；保留状态码供差异化恢复（409 重试 / 429 退避 / 403 fail-fast）。 */
export class GovernanceHttpError extends Error {
  constructor(public readonly status: number) {
    super(`aiwarden HTTP ${status}`);
    this.name = "GovernanceHttpError";
  }
}

/** 治理拒绝（PENDING_APPROVAL / REJECTED）：仍然 throw，副作用不得发生。 */
export class GovernanceDeniedError extends Error {
  constructor(public readonly governanceStatus: string) {
    super(`治理拒绝执行（${governanceStatus}）`);
    this.name = "GovernanceDeniedError";
  }
}

/** 响应形状违反契约（非数组 / 缺字段 / JSON 坏）：显式失败，不填 0、不伪造标签。 */
export class GovernanceContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GovernanceContractError";
  }
}
