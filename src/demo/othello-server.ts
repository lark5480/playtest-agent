/**
 * 测试用 othello-online HTTP 假服务。
 *
 * 只实现 OthelloLocalAdapter 用到的四个端点，规则按 othello-online 的
 * `server/mockApi.ts` 与 `src/utils/gameLogic.ts` 行为独立重写，避免契约测试
 * 依赖真实游戏进程。`updatedAt` 与真实服务一致，取当前时间戳——
 * 适配器若把它暴露进状态 payload，契约的"同 seed 初始状态一致"会如实失败。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const BOARD_SIZE = 8;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

type Player = "black" | "white";
type RoomStatus = "waiting" | "playing" | "finished";
type Winner = Player | "draw" | null;
type Board = number[][];

interface StubRoom {
  roomId: string;
  status: RoomStatus;
  board: Board;
  currentTurn: Player;
  moveCount: number;
  winner: Winner;
  updatedAt: number;
  blackId: string;
  whiteId: string | null;
}

export interface OthelloStubServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

export interface OthelloFixtureOptions {
  readonly fault?: "missed-flip";
  readonly faultAtStep?: number;
}

export async function startOthelloStubServer(
  options: OthelloFixtureOptions = {},
): Promise<OthelloStubServer> {
  const rooms = new Map<string, StubRoom>();
  let counter = 0;

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = (req.method ?? "GET").toUpperCase();

      if (method === "GET" && path === "/") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && path === "/api/room/create") {
        const body = await readJson(req);
        const playerId = body["playerId"];
        if (typeof playerId !== "string" || !playerId) {
          sendJson(res, 400, { error: "playerId required" });
          return;
        }
        counter += 1;
        const roomId = `R${String(counter).padStart(5, "0")}`;
        const now = Date.now();
        const room: StubRoom = {
          roomId,
          status: "waiting",
          board: createInitialBoard(),
          currentTurn: "black",
          moveCount: 0,
          winner: null,
          updatedAt: now,
          blackId: playerId,
          whiteId: null,
        };
        rooms.set(roomId, room);
        sendJson(res, 201, { roomId, state: publicState(room) });
        return;
      }

      const match = /^\/api\/room\/([^/]+)\/(join|state|move)$/.exec(path);
      if (match) {
        const roomId = match[1]!;
        const action = match[2];
        const room = rooms.get(roomId);
        if (!room) {
          sendJson(res, 404, { error: "room not found" });
          return;
        }

        if (method === "POST" && action === "join") {
          const body = await readJson(req);
          const playerId = body["playerId"];
          if (typeof playerId !== "string" || !playerId) {
            sendJson(res, 400, { error: "playerId required" });
            return;
          }
          if (room.whiteId && room.whiteId !== playerId) {
            sendJson(res, 409, { error: "room full" });
            return;
          }
          if (!room.whiteId) {
            room.whiteId = playerId;
            room.status = "playing";
            room.updatedAt = nextTimestamp(room.updatedAt);
          }
          sendJson(res, 200, { state: publicState(room) });
          return;
        }

        if (method === "GET" && action === "state") {
          sendJson(res, 200, { state: publicState(room) });
          return;
        }

        if (method === "POST" && action === "move") {
          const body = await readJson(req);
          const playerId = body["playerId"];
          const row = body["row"];
          const col = body["col"];
          const expectedUpdatedAt = body["expectedUpdatedAt"];

          if (typeof playerId !== "string" || typeof row !== "number" || typeof col !== "number") {
            sendJson(res, 400, { error: "playerId, row, col required" });
            return;
          }
          if (typeof expectedUpdatedAt === "number" && room.updatedAt !== expectedUpdatedAt) {
            sendJson(res, 409, { error: "state conflict" });
            return;
          }
          if (room.status !== "playing") {
            sendJson(res, 409, { error: "not playing" });
            return;
          }
          const currentId = room.currentTurn === "black" ? room.blackId : room.whiteId;
          if (currentId !== playerId) {
            sendJson(res, 409, { error: "not your turn" });
            return;
          }
          if (
            !Number.isInteger(row) ||
            !Number.isInteger(col) ||
            row < 0 ||
            row >= BOARD_SIZE ||
            col < 0 ||
            col >= BOARD_SIZE ||
            getFlips(room.board, row, col, room.currentTurn).length === 0
          ) {
            sendJson(res, 400, { error: "invalid move" });
            return;
          }

          const missed = getFlips(room.board, row, col, room.currentTurn)[0];
          const previous = missed ? room.board[missed[0]]![missed[1]]! : EMPTY;
          room.board = applyMove(room.board, row, col, room.currentTurn);
          if (
            options.fault === "missed-flip" &&
            room.moveCount === (options.faultAtStep ?? 5) &&
            missed
          ) {
            room.board[missed[0]]![missed[1]] = previous;
          }
          room.moveCount += 1;
          room.updatedAt = nextTimestamp(room.updatedAt);

          const opponent: Player = room.currentTurn === "black" ? "white" : "black";
          if (hasAnyValidMove(room.board, opponent)) {
            room.currentTurn = opponent;
          } else if (hasAnyValidMove(room.board, room.currentTurn)) {
            // 对方无子可下，跳过，保持当前回合。
          } else {
            room.status = "finished";
            room.winner = decideWinner(room.board);
          }

          sendJson(res, 200, { state: publicState(room) });
          return;
        }
      }

      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function createInitialBoard(): Board {
  const board: Board = Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => EMPTY),
  );
  const mid = BOARD_SIZE / 2;
  board[mid - 1]![mid - 1] = WHITE;
  board[mid - 1]![mid] = BLACK;
  board[mid]![mid - 1] = BLACK;
  board[mid]![mid] = WHITE;
  return board;
}

function getFlips(board: Board, row: number, col: number, player: Player): Array<[number, number]> {
  if (board[row]?.[col] !== EMPTY) return [];
  const me = player === "black" ? BLACK : WHITE;
  const opp = player === "black" ? WHITE : BLACK;
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

function applyMove(board: Board, row: number, col: number, player: Player): Board {
  const me = player === "black" ? BLACK : WHITE;
  const next = board.map((line) => line.slice());
  next[row]![col] = me;
  for (const [r, c] of getFlips(board, row, col, player)) {
    next[r]![c] = me;
  }
  return next;
}

function hasAnyValidMove(board: Board, player: Player): boolean {
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if (board[row]?.[col] === EMPTY && getFlips(board, row, col, player).length > 0) {
        return true;
      }
    }
  }
  return false;
}

function decideWinner(board: Board): Winner {
  let black = 0;
  let white = 0;
  for (const line of board) {
    for (const stone of line) {
      if (stone === BLACK) black += 1;
      else if (stone === WHITE) white += 1;
    }
  }
  if (black > white) return "black";
  if (white > black) return "white";
  return "draw";
}

function publicState(room: StubRoom) {
  return {
    roomId: room.roomId,
    status: room.status,
    board: room.board,
    currentTurn: room.currentTurn,
    players: { black: null, white: null },
    moveCount: room.moveCount,
    lastMove: null,
    moves: [],
    winner: room.winner,
    createdAt: room.updatedAt,
    updatedAt: room.updatedAt,
  };
}

/** 保证同房间的版本戳严格递增，避免同毫秒内两次写入拿到相同值。 */
function nextTimestamp(previous: number): number {
  return Math.max(Date.now(), previous + 1);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += String(chunk);
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

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
