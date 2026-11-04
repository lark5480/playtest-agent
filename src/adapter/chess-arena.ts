/**
 * 适配器 · chess-arena（本地 Next.js API）
 *
 * chess-arena 自带内存版房间 API（`app/api/rooms/**`），无需数据库或云端账号：
 * - `POST /api/rooms` 建房（白方）
 * - `POST /api/rooms/{code}/join` 加入（黑方）
 * - `GET  /api/rooms/{code}` 取房间快照
 * - `POST /api/rooms/{code}/move` 走子
 *
 * 与 othello 适配器的同一条原则：合法着在本地独立计算，
 * 不复用被测游戏的 chess.js（见 `src/core/chess-rules.ts`）。
 *
 * 终局判定：将死/逼和来自服务端与本地推演；**三次重复与 50 步由本地 FEN 历史
 * 独立判定**（`analyzeHistory`），服务端没判出来时由适配器补上，不依赖它的 `winner`。
 *
 * 已知边界：move 接口按 IP 限流 60 次/分钟；撞上 429 时等待一个窗口后重试一次，
 * 429 明确表示动作未处理，重试是遵守限流而不是绕过。
 */

import {
  analyzeHistory,
  generateLegalMoves,
  moveId,
  parseFen,
  positionToFen,
  squareName,
  startPosition,
} from "../core/chess-rules.js";
import type { Action, GameState, Observation } from "../types/game.js";

import type { GameAdapter } from "./game-adapter.js";

type ArenaColor = "white" | "black";
type ArenaStatus = "waiting" | "playing" | "finished";

/** chess-arena 的新房间总是从标准初始局面开始，用它作为历史的第一项。 */
const START_FEN = positionToFen(startPosition());

interface ArenaMove {
  moveNumber: number;
  san: string;
  fen: string;
  from: string;
  to: string;
  promotion?: string;
  playedBy: ArenaColor;
}

interface ArenaResult {
  winner: ArenaColor | null;
  reason: string;
}

interface ArenaRoom {
  code: string;
  status: ArenaStatus;
  currentFen: string;
  turn: ArenaColor;
  moves: ArenaMove[];
  gameOver: boolean;
  result?: ArenaResult;
}

interface ArenaCreateResponse {
  code: string;
  playerId: string;
  color: ArenaColor;
}

interface ArenaJoinResponse extends ArenaCreateResponse {
  room: ArenaRoom;
}

interface ArenaMoveResponse {
  ok: boolean;
  error?: string;
  move?: ArenaMove;
  fen?: string;
  turn?: ArenaColor;
  gameOver?: boolean;
  result?: ArenaResult;
}

export interface ChessArenaOptions {
  /** 被测游戏地址；chess-arena 默认 `npm run dev` 监听 3000。 */
  readonly baseUrl?: string;
  /** 请求超时（毫秒）。 */
  readonly timeoutMs?: number;
  /**
   * 撞上 429（走子接口 60 次/分钟滑动窗口）时等待多久再重试一次。
   * 等待是为了**遵守**限流，不是绕过；429 明确表示动作未被处理，重试是安全的。
   */
  readonly rateLimitWaitMs?: number;
}

export class ChessArenaAdapter implements GameAdapter {
  readonly name = "chess-arena";

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly rateLimitWaitMs: number;

  public constructor(options: ChessArenaOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://localhost:3000").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.rateLimitWaitMs = options.rateLimitWaitMs ?? 61_000;
  }

  async open(params: { readonly seed: number }): Promise<{ state: GameState; token: string }> {
    const created = await this.request<ArenaCreateResponse>("POST", "/api/rooms", {
      name: `playtest-white-${params.seed}`,
      // 0 = 无时限：自动测试不应因钟面耗尽而中断。
      timeLimit: 0,
    });

    const joined = await this.request<ArenaJoinResponse>(
      "POST",
      `/api/rooms/${created.code}/join`,
      { name: `playtest-black-${params.seed}` },
    );

    return {
      state: this.toGameState(joined.room),
      // token 承载房间号与黑白凭证；**不写进日志与报告**。
      token: JSON.stringify({
        code: created.code,
        whiteId: created.playerId,
        blackId: joined.playerId,
      }),
    };
  }

  async resume(params: { readonly token: string }): Promise<{ state: GameState } | null> {
    const { code } = this.parseToken(params.token);
    try {
      const room = await this.request<ArenaRoom>("GET", `/api/rooms/${code}`);
      return { state: this.toGameState(room) };
    } catch {
      // 404 = 房间不存在（游戏进程重启）→ 不可恢复。
      return null;
    }
  }

  async observe(params: {
    readonly state: GameState;
    readonly token: string;
  }): Promise<Observation> {
    const { code } = this.parseToken(params.token);
    const room = await this.request<ArenaRoom>("GET", `/api/rooms/${code}`);
    return {
      state: this.toGameState(room),
      seq: Number(params.state.payload["seq"] ?? 0) + 1,
      at: Date.now(),
    };
  }

  async act(params: {
    readonly state: GameState;
    readonly token: string;
    readonly action: Action;
  }): Promise<{ ok: boolean; observation?: Observation; error?: string }> {
    const { code, whiteId, blackId } = this.parseToken(params.token);
    const turn = params.state.turn;
    if (turn === null) return { ok: false, error: "对局已结束，无法走子" };

    const playerId = turn === "white" ? whiteId : blackId;
    const from = String(params.action.payload["from"] ?? "");
    const to = String(params.action.payload["to"] ?? "");
    const promotion = params.action.payload["promotion"];
    if (!from || !to) return { ok: false, error: "动作缺少 from/to" };

    try {
      const res = await this.requestMove(code, {
        playerId,
        from,
        to,
        ...(typeof promotion === "string" ? { promotion } : {}),
      });

      if (!res.ok || !res.move || !res.fen || !res.turn) {
        return { ok: false, error: res.error ?? "走子被拒绝" };
      }

      const moves = this.readMoves(params.state).concat(res.move.san);
      const fenHistory = this.readFenHistory(params.state).concat(res.fen);
      return {
        ok: true,
        observation: {
          state: this.buildState({
            code,
            fen: res.fen,
            turn: res.turn,
            status: res.gameOver ? "finished" : "playing",
            moves,
            fenHistory,
            result: res.result ?? null,
          }),
          seq: Number(params.state.payload["seq"] ?? 0) + 1,
          at: Date.now(),
        },
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  isTerminal(params: { readonly state: GameState }): boolean {
    const state = params.state;
    if (state.status === "finished") return true;
    return state.turn !== null && state.legalActions.length === 0;
  }

  // ---------------------------------------------------------------- 内部

  private toGameState(room: ArenaRoom): GameState {
    const status: ArenaStatus = room.gameOver ? "finished" : room.status;
    return this.buildState({
      code: room.code,
      fen: room.currentFen,
      turn: room.turn,
      status,
      moves: room.moves.map((move) => move.san),
      // 历史第一项是初始局面，之后每一步的 FEN 都来自服务端，但判定在本地做。
      fenHistory: [START_FEN, ...room.moves.map((move) => move.fen)],
      result: room.result ?? null,
    });
  }

  private buildState(params: {
    readonly code: string;
    readonly fen: string;
    readonly turn: ArenaColor;
    readonly status: ArenaStatus;
    readonly moves: readonly string[];
    readonly fenHistory: readonly string[];
    readonly result: ArenaResult | null;
  }): GameState {
    let status: ArenaStatus = params.status;
    let result = params.result;
    let legalActions = status === "finished" ? [] : this.computeLegalActions(params.fen);

    // 历史型和棋：本地独立判定。棋盘仍有合法着时，三次重复 / 50 步直接终局；
    // 无合法着时交给将死/逼和语义，不在这里抢判。
    if (status !== "finished" && legalActions.length > 0) {
      const history = analyzeHistory(params.fenHistory);
      if (history.reason !== null) {
        status = "finished";
        result = { winner: null, reason: history.reason };
        legalActions = [];
      }
    }

    return {
      id: params.code,
      status,
      turn: status === "finished" ? null : params.turn,
      legalActions,
      payload: {
        fen: params.fen,
        moveCount: params.moves.length,
        moves: [...params.moves],
        fenHistory: [...params.fenHistory],
        result,
        seq: params.moves.length,
      },
    };
  }

  /** 从 FEN 独立生成合法着（按固定顺序，保证可复现）。 */
  private computeLegalActions(fen: string): Action[] {
    const position = parseFen(fen);
    return generateLegalMoves(position).map((move) => {
      const payload: Record<string, unknown> = {
        from: squareName(move.from),
        to: squareName(move.to),
      };
      if (move.promotion) payload["promotion"] = move.promotion;
      return { id: moveId(move), payload };
    });
  }

  private readMoves(state: GameState): string[] {
    const raw = state.payload["moves"];
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
  }

  /** 读上一步留下的 FEN 历史；缺失时退回当前局面（仍能判 50 步，但判不了重复）。 */
  private readFenHistory(state: GameState): string[] {
    const raw = state.payload["fenHistory"];
    if (Array.isArray(raw)) {
      const list = raw.filter((item): item is string => typeof item === "string");
      if (list.length > 0) return list;
    }
    const fen = state.payload["fen"];
    return [typeof fen === "string" ? fen : START_FEN];
  }

  private parseToken(token: string): { code: string; whiteId: string; blackId: string } {
    return JSON.parse(token) as { code: string; whiteId: string; blackId: string };
  }

  /** 走子请求：遇到 429 等待一个窗口后重试一次。 */
  private async requestMove(
    code: string,
    body: Record<string, unknown>,
  ): Promise<ArenaMoveResponse> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.request<ArenaMoveResponse>("POST", `/api/rooms/${code}/move`, body);
      } catch (error) {
        const rateLimited = error instanceof HttpError && error.status === 429;
        if (!rateLimited || attempt >= 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, this.rateLimitWaitMs));
      }
    }
  }

  /** 发起一次 HTTP 请求；非 2xx 视为失败并抛出。 */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new HttpError(
          res.status,
          `${method} ${path} → HTTP ${res.status} ${text.slice(0, 120)}`,
        );
      }
      return text ? (JSON.parse(text) as T) : ({} as T);
    } finally {
      clearTimeout(timer);
    }
  }
}

class HttpError extends Error {
  public readonly status: number;

  public constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}
