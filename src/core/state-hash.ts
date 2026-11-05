/**
 * 纯函数 · 对局状态指纹
 *
 * 续跑判定用：只哈希**语义状态**（status / turn / payload），
 * 不含 observation.seq / at 这类时序字段。
 *
 * 适配器可提供 `stateDigest` 覆盖默认口径（例如 chess 的 payload 里
 * `moves` 是展示用 SAN，`fenHistory` 已覆盖同一信息）。
 */

import { createHash } from "node:crypto";

import { canonicalize } from "./fingerprint.js";
import type { GameState } from "../types/game.js";

/** 对任意 JSON 值做稳定摘要（键序无关）。 */
export function hashOf(value: unknown): string {
  const canonical = canonicalize(value);
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

/** 默认状态指纹：status + turn + payload。 */
export function stateHashOf(state: GameState): string {
  return hashOf({ status: state.status, turn: state.turn, payload: state.payload });
}
