/**
 * 纯函数内核 · 种子化 PRNG
 *
 * 依赖克制的红线之一：**不引入随机库**（对齐 tongshi-ju 红线 2.4）。
 *
 * 选 mulberry32：32 位状态、实现短、无已知偏斜问题、跨平台位运算一致
 * （用 `>>>` 与 `Math.imul` 保证 32 位溢出语义与 JS 引擎无关）。
 *
 * 用途：让"同 seed + 同局面 → 同动作"成为**可复现的机制**，
 * 而不是靠运气。Agent 的每一步随机性都必须来自这里，且 seed 写进报告。
 */

/** mulberry32 内部状态。 */
export type Prng = () => number;

/**
 * 从任意字符串派生一个 32 位种子（FNV-1a）。
 */
export function seedFrom(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * 创建一个种子化随机数发生器。
 *
 * 返回的函数产出 `[0, 1)` 区间的浮点数，**同 seed 必得同序列**。
 */
export function createPrng(seed: number): Prng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 从序列中取一个整数（`[0, max)`）。
 *
 * 用拒绝采样消除取模偏斜 —— 均匀性对"探索合法动作"很重要，
 * 否则某些动作会被系统性偏多地选中。
 */
export function randomInt(prng: Prng, max: number): number {
  if (max <= 0) return 0;
  const limit = Math.floor(0x100000000 / max) * max;
  let value = Math.floor(prng() * 0x100000000);
  while (value >= limit) {
    value = Math.floor(prng() * 0x100000000);
  }
  return value % max;
}

/**
 * 从数组中确定性地取一个元素。
 *
 * 空数组返回 undefined（不是抛错 —— 调用方据此走"无可行动作"分支）。
 */
export function pickOne<T>(prng: Prng, items: readonly T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[randomInt(prng, items.length)];
}

/**
 * 确定性洗牌（Fisher–Yates，不改原数组）。
 */
export function shuffle<T>(prng: Prng, items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(prng, i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}
