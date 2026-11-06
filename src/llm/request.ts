/** 安全错误：不携带服务端 body、URL、认证头或底层异常文本。 */
export class LlmRequestError extends Error {
  constructor(
    public readonly category: "http" | "timeout" | "cancelled" | "network" | "invalid-response",
    public readonly status?: number,
  ) {
    super(
      category === "http"
        ? `模型请求失败：HTTP ${status}`
        : category === "timeout"
          ? "模型调用超时"
          : category === "cancelled"
            ? "模型调用已取消"
            : category === "invalid-response"
              ? "模型响应格式无效"
              : "模型连接失败",
    );
    this.name = "LlmRequestError";
  }
}

export function cancellationError(signal: AbortSignal): LlmRequestError {
  const reason: unknown = signal.reason;
  return new LlmRequestError(
    reason instanceof Error && reason.name === "TimeoutError" ? "timeout" : "cancelled",
  );
}

/** 即使第三方客户端忽略 signal，也结清本地在途账目；signal 同时传给真实 fetch。 */
export async function abortable<T>(
  signal: AbortSignal | undefined,
  invoke: () => Promise<T>,
): Promise<T> {
  if (!signal) return invoke();
  if (signal.aborted) throw cancellationError(signal);
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(cancellationError(signal));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([invoke(), cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
