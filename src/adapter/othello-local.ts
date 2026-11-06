/**
 * 适配器 · othello-online（本地 mock API）
 *
 * 目标：驱动 `othello-online` 的**本地**实例（`vite preview` + `mockApiPlugin`），
 * **零云端依赖** —— 无需 EdgeOne 账号、无需 KV 绑定。
 *
 * 为什么用 HTTP 而不是进程内 import：
 * HTTP 更接近"黑盒用户"的真相 —— Agent 只知道公开 API 契约，
 * 不知道游戏内部实现。这也让适配器能测到"接口层"的问题
 * （如 409 冲突、乐观并发），而进程内 import 测不到。
 *
 * 合法动作集：**在适配器本地独立计算**（不复用游戏的 `gameLogic`）——
 * 理由见 AGENTS / ARCHITECTURE：Oracle 与策略必须独立于被测实现，
 * 否则共模错误互相掩盖。
 */

import type { Action, GameState, Observation } from "../types/game.js";

import type { GameAdapter } from "./game-adapter.js";
import { AdapterHttpError, actionErrorMessage } from "./http-error.js";

/** othello 的棋盘常量（0 空 / 1 黑 / 2 白）。 */
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;
const BOARD_SIZE = 8;

/** mock API 的公开状态形状（只取本适配器用到的字段）。 */
interface PublicState {
  roomId: string;
  status: "waiting" | "playing" | "finished";
  board: number[][];
  currentTurn: "black" | "white";
  moveCount: number;
  winner: "black" | "white" | "draw" | null;
  /**
   * 乐观并发版本戳（用于 `expectedUpdatedAt`）。
   *
   * **不放进 GameState.payload**：它是服务端写入时刻，同 seed 的两局也必然不同；
   * 放进 payload 会破坏"同 seed 初始状态一致"的适配器契约。适配器按房间号
   * 私有缓存最新值，`act` 时取用。
   */
  updatedAt: number;
}

export interface OthelloLocalOptions {
  /**
   * 被测游戏地址。
   *
   * 默认用 `localhost` 而非 `127.0.0.1` —— Vite preview 默认只绑 IPv6 `::1`，
   * 用 IPv4 字面量会连不上（实测：本机 `127.0.0.1:5173` 连接被拒，
   * `localhost:5173` 正常）。`localhost` 会按系统解析顺序回退，两者都能覆盖。
   */
  readonly baseUrl?: string;
  /** 请求超时（毫秒）。 */
  readonly timeoutMs?: number;
}

export class OthelloLocalAdapter implements GameAdapter {
  readonly name = "othello-local";
  readonly supportsConditionalAct = true;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  /** 版本戳绑定观察对象，后来的 observe 不得给旧局面升级 CAS 版本。 */
  private readonly updatedAtByState = new WeakMap<GameState, number>();

  public constructor(options: OthelloLocalOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://localhost:5173").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async open(params: { readonly seed: number }): Promise<{ state: GameState; token: string }> {
    // 玩家标识用 seed 派生：同 seed 的运行用同一批标识，便于对照。
    const blackId = `black-${params.seed}`;
    const whiteId = `white-${params.seed}`;

    const created = await this.request<{ roomId: string; state: PublicState }>(
      "POST",
      "/api/room/create",
      { playerId: blackId },
    );
    const roomId = created.roomId;

    // 自对弈：同一个 Agent 持黑、白两个身份。
    const joined = await this.request<{ state: PublicState }>("POST", `/api/room/${roomId}/join`, {
      playerId: whiteId,
    });

    return {
      state: this.toGameState(joined.state),
      // token 承载两个玩家身份 + 房间号；**不写进日志与报告**。
      token: JSON.stringify({ roomId, blackId, whiteId }),
    };
  }

  /**
   * 只建房，**不占用**白方座位。
   *
   * 用于"两个客户端进同一房间"的并发场景 —— `open()` 会自对弈占满双方，
   * 第二个客户端就 join 不进来了（409 room full）。
   */
  async createRoom(params: {
    readonly seed: number;
  }): Promise<{ state: GameState; token: string }> {
    const blackId = `black-${params.seed}`;
    const created = await this.request<{ roomId: string; state: PublicState }>(
      "POST",
      "/api/room/create",
      { playerId: blackId },
    );
    return {
      state: this.toGameState(created.state),
      token: JSON.stringify({
        roomId: created.roomId,
        blackId,
        whiteId: "",
      }),
    };
  }

  /**
   * 从凭证恢复一局。
   *
   * 房间是内存态的，游戏进程没重启就能恢复；重启后房间丢失 → 返回 null
   * （驱动会显式失败并保留检查点，不自动重建一局）。
   */
  async resume(params: { readonly token: string }): Promise<{ state: GameState } | null> {
    const { roomId } = this.parseToken(params.token);
    try {
      const res = await this.request<{ state: PublicState }>("GET", `/api/room/${roomId}/state`);
      return { state: this.toGameState(res.state) };
    } catch {
      // 404 = 房间不存在（游戏进程已重启）→ 不可恢复
      return null;
    }
  }

  async observe(params: { state: GameState; token: string }): Promise<Observation> {
    const { roomId } = this.parseToken(params.token);
    const res = await this.request<{ state: PublicState }>("GET", `/api/room/${roomId}/state`);
    return {
      state: this.toGameState(res.state),
      seq: Number(params.state.payload["seq"] ?? 0) + 1,
      at: Date.now(),
    };
  }

  async act(params: {
    state: GameState;
    token: string;
    action: Action;
  }): Promise<{ ok: boolean; observation?: Observation; error?: string }> {
    const { roomId, blackId, whiteId } = this.parseToken(params.token);
    const turn = params.state.turn === "black" ? blackId : whiteId;
    const row = Number(params.action.payload["row"]);
    const col = Number(params.action.payload["col"]);
    const expectedUpdatedAt = this.updatedAtByState.get(params.state);
    if (typeof expectedUpdatedAt !== "number") {
      // 不静默跳过并发校验：othello 服务端的 expectedUpdatedAt 是可选的，
      // 缺省时过期局面会被直接接受。缓存缺失说明调用方绕过了
      // open / resume / observe，此时继续落子等于假装并发保护仍然有效。
      throw new Error(
        "othello 适配器缺少局面的版本戳缓存：" +
          "act 前必须先 open / resume / observe 取得最新局面，否则无法发送 expectedUpdatedAt，服务端会跳过并发校验。",
      );
    }

    try {
      const res = await this.request<{ state: PublicState }>("POST", `/api/room/${roomId}/move`, {
        playerId: turn,
        row,
        col,
        // **必须传 `expectedUpdatedAt`**：othello 的乐观并发校验是**可选**的
        // （`server/mockApi.ts` 与 `edge-functions/api/room/[roomId]/move.ts`
        //   都是 `typeof expectedUpdatedAt === 'number' && ...`）——
        //   不传就等于放弃并发保护，基于过期局面的落子会被静默接受。
        // 缓存缺失时已在上面显式抛错，不会走到这里。
        expectedUpdatedAt,
      });
      return {
        ok: true,
        observation: {
          state: this.toGameState(res.state),
          seq: Number(params.state.payload["seq"] ?? 0) + 1,
          at: Date.now(),
        },
      };
    } catch (error) {
      return { ok: false, error: actionErrorMessage("othello", error) };
    }
  }

  isTerminal(params: { state: GameState }): boolean {
    return params.state.status === "finished";
  }

  /**
   * 本地投影执行落子后的状态（**不产生任何副作用**）。
   *
   * 只用于续跑判定。投影必须与游戏服务端的结果逐字段一致；
   * 对不上时驱动会显式失败，而不是猜。
   */
  projectAfter(params: { readonly state: GameState; readonly action: Action }): GameState | null {
    const rawBoard = params.state.payload["board"];
    if (!Array.isArray(rawBoard) || rawBoard.length !== BOARD_SIZE) return null;
    const board = rawBoard as number[][];

    const row = Number(params.action.payload["row"]);
    const col = Number(params.action.payload["col"]);
    if (!Number.isInteger(row) || !Number.isInteger(col)) return null;
    if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return null;

    const turn =
      params.state.turn === "black" ? BLACK : params.state.turn === "white" ? WHITE : null;
    if (turn === null) return null;

    const flips = this.flipsFor(board, row, col, turn);
    if (flips.length === 0) return null;

    const nextBoard = board.map((line) => [...line]);
    nextBoard[row]![col] = turn;
    for (const [r, c] of flips) nextBoard[r]![c] = turn;

    const me = turn === BLACK ? "black" : "white";
    const opp = me === "black" ? "white" : "black";
    const oppMoves = this.computeLegalActions(nextBoard, opp);
    const myMoves = this.computeLegalActions(nextBoard, me);

    let status: GameState["status"] = "playing";
    let nextTurn: "black" | "white" | null = opp;
    let winner: "black" | "white" | "draw" | null = null;

    if (oppMoves.length === 0) {
      if (myMoves.length === 0) {
        status = "finished";
        nextTurn = null;
        const blackCount = countStones(nextBoard, BLACK);
        const whiteCount = countStones(nextBoard, WHITE);
        winner = blackCount > whiteCount ? "black" : whiteCount > blackCount ? "white" : "draw";
      } else {
        // 对方无子可下 → 跳过，保持当前回合
        nextTurn = me;
      }
    }

    const moveCount = Number(params.state.payload["moveCount"] ?? 0) + 1;
    return {
      id: params.state.id,
      status,
      turn: nextTurn,
      legalActions:
        status === "finished" || nextTurn === null
          ? []
          : this.computeLegalActions(nextBoard, nextTurn),
      payload: {
        board: nextBoard,
        moveCount,
        winner,
        seq: moveCount,
      },
    };
  }

  // ---------------------------------------------------------------- 内部

  /** 把服务端公开状态转成 Agent 的 GameState。 */
  private toGameState(publicState: PublicState): GameState {
    const legalActions = this.computeLegalActions(publicState.board, publicState.currentTurn);
    const state: GameState = {
      id: publicState.roomId,
      status: publicState.status,
      turn: publicState.status === "finished" ? null : publicState.currentTurn,
      legalActions,
      payload: {
        board: publicState.board,
        moveCount: publicState.moveCount,
        winner: publicState.winner,
        seq: Number(publicState.moveCount),
      },
    };
    this.updatedAtByState.set(state, publicState.updatedAt);
    return state;
  }

  /**
   * 独立计算合法落子点（不复用游戏的规则实现）。
   *
   * 规则：在八个方向上，从落点起连续夹住至少一颗对方棋子，
   * 且末端必须是己方棋子，才算合法。
   */
  private computeLegalActions(board: number[][], turn: "black" | "white"): Action[] {
    const me = turn === "black" ? BLACK : WHITE;
    const actions: Action[] = [];

    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        if (this.flipsFor(board, row, col, me).length === 0) continue;
        actions.push({ id: `${row},${col}`, payload: { row, col } });
      }
    }
    return actions;
  }

  /**
   * 在指定落点能夹住并翻转的对方棋子坐标。
   *
   * 与合法动作生成共用同一套方向规则，避免「能下」与「翻哪些」两处逻辑漂移。
   */
  private flipsFor(
    board: number[][],
    row: number,
    col: number,
    me: number,
  ): Array<[number, number]> {
    if (board[row]?.[col] !== EMPTY) return [];
    const opp = me === BLACK ? WHITE : BLACK;
    const flips: Array<[number, number]> = [];

    for (const [dr, dc] of DIRECTIONS) {
      const line: Array<[number, number]> = [];
      let r = row + dr;
      let c = col + dc;
      while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r]?.[c] === opp) {
        line.push([r, c]);
        r += dr;
        c += dc;
      }
      if (
        line.length > 0 &&
        r >= 0 &&
        r < BOARD_SIZE &&
        c >= 0 &&
        c < BOARD_SIZE &&
        board[r]?.[c] === me
      ) {
        flips.push(...line);
      }
    }

    return flips;
  }

  private parseToken(token: string): { roomId: string; blackId: string; whiteId: string } {
    try {
      const parsed = JSON.parse(token) as { roomId: string; blackId: string; whiteId: string };
      if (
        !parsed ||
        typeof parsed.roomId !== "string" ||
        typeof parsed.blackId !== "string" ||
        typeof parsed.whiteId !== "string"
      )
        throw new Error();
      return parsed;
    } catch {
      throw new Error("othello 凭证格式无效");
    }
  }

  /**
   * 以指定身份加入**已有**房间（用于模拟两个客户端进同一房间）。
   *
   * 自对弈场景下：一个客户端持黑方身份、另一个持白方身份，
   * 两者共享同一个房间号。
   */
  async join(params: {
    readonly roomId: string;
    readonly playerId: string;
  }): Promise<{ state: GameState; token: string }> {
    const joined = await this.request<{ state: PublicState }>(
      "POST",
      `/api/room/${params.roomId}/join`,
      { playerId: params.playerId },
    );
    const { roomId } = this.parseToken(
      JSON.stringify({ roomId: params.roomId, blackId: params.playerId, whiteId: params.playerId }),
    );
    return {
      state: this.toGameState(joined.state),
      token: JSON.stringify({
        roomId,
        blackId: params.playerId,
        whiteId: params.playerId,
      }),
    };
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
        throw new AdapterHttpError("othello", res.status);
      }
      return text ? (JSON.parse(text) as T) : ({} as T);
    } catch (error) {
      if (error instanceof AdapterHttpError) throw error;
      throw new Error("othello 请求失败（网络或响应无效）");
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 八个方向（与游戏的 DIRECTIONS 一致，但此处独立声明）。 */
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

function countStones(board: number[][], color: number): number {
  let count = 0;
  for (const row of board) {
    for (const cell of row) {
      if (cell === color) count += 1;
    }
  }
  return count;
}
