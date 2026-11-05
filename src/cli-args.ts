/**
 * CLI 参数解析（纯函数，便于单测）
 *
 * 解析规则：
 * - 第一个非 `--` 开头的词是子命令；
 * - `--key=value` 与 `--key value` 都支持；
 * - 若 `--key` 后面紧跟另一个 `--flag`，视为该 key 缺少取值（值为空串），
 *   不吞掉下一个 flag。
 */

export interface CliArgs {
  readonly command: string;
  readonly options: ReadonlyMap<string, string>;
}

export class CliArgError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliArgError";
  }
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const options = new Map<string, string>();
  let command = "";
  let pendingKey: string | null = null;

  const flush = (): void => {
    if (pendingKey !== null) {
      options.set(pendingKey, "");
      pendingKey = null;
    }
  };

  for (const arg of argv) {
    if (arg === "--") continue;

    if (pendingKey !== null) {
      if (arg.startsWith("--")) {
        flush();
        // 当前参数是新的 flag，继续按 flag 处理。
      } else {
        options.set(pendingKey, arg);
        pendingKey = null;
        continue;
      }
    }

    if (arg.startsWith("--")) {
      const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
      if (match) {
        const key = match[1]!;
        const value = match[2];
        if (value === undefined) {
          pendingKey = key;
        } else {
          options.set(key, value);
        }
      }
      continue;
    }

    if (!command) command = arg;
  }

  flush();
  return { command, options };
}

/** 读取整数选项；缺省返回 undefined，非法值抛 CliArgError。 */
export function readInteger(
  options: ReadonlyMap<string, string>,
  key: string,
  bounds: { readonly min?: number; readonly max?: number } = {},
): number | undefined {
  const raw = options.get(key);
  if (raw === undefined || raw === "") return undefined;
  if (!/^-?\d+$/.test(raw)) {
    throw new CliArgError(`--${key} 必须是整数（当前："${raw}"）`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new CliArgError(`--${key} 超出安全整数范围（当前："${raw}"）`);
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throw new CliArgError(`--${key} 必须 ≥ ${bounds.min}（当前：${value}）`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new CliArgError(`--${key} 必须 ≤ ${bounds.max}（当前：${value}）`);
  }
  return value;
}

/** 读取非空字符串选项；缺省/空串返回 undefined。 */
export function readString(options: ReadonlyMap<string, string>, key: string): string | undefined {
  const raw = options.get(key);
  return raw === undefined || raw === "" ? undefined : raw;
}
