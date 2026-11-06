/** 适配器 HTTP 错误：保留状态码用于分类，绝不携带响应体。 */
export class AdapterHttpError extends Error {
  public constructor(
    public readonly adapter: string,
    public readonly status: number,
  ) {
    super(`${adapter} HTTP ${status}`);
    this.name = "AdapterHttpError";
  }
}

export function actionErrorMessage(adapter: string, error: unknown): string {
  if (error instanceof AdapterHttpError) {
    const reason =
      error.status === 409
        ? "并发冲突"
        : error.status === 400
          ? "非法动作或参数"
          : error.status === 429
            ? "被限流"
            : "被拒绝";
    return `${adapter} 动作失败：HTTP ${error.status}（${reason}）`;
  }
  return `${adapter} 动作失败（网络或响应无效）`;
}
