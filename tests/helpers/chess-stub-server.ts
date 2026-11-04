/**
 * 测试用 chess-arena HTTP 假服务。
 *
 * 只实现适配器用到的四个端点，规则推演复用本项目自实现的纯函数内核。
 * 目的是让适配器单测/契约测试**不依赖**真实 chess-arena 进程。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  applyMove,
  generateLegalMoves,
  isInCheck,
  moveId,
  parseFen,
  positionToFen,
  startPosition,
} from "../../src/core/chess-rules.js";
import type { ChessColor } from "../../src/core/chess-rules.js";

type ArenaColor = "white" | "black";
type ArenaStatus = "waiting" | "playing" | "finished";

interface StubMove {
  moveNumber: number;
  san: string;
  fen: string;
  from: string;
  to: string;
  promotion?: string;
  playedBy: ArenaColor;
}

interface StubRoom {
  code: string;
  status: ArenaStatus;
  fen: string;
  turn: ArenaColor;
  moves: StubMove[];
  whiteId: string;
  blackId: string;
  result: { winner: ArenaColor | null; reason: string } | null;
}

export interface ChessStubServer {
  readonly baseUrl: string;
  /** 让接下来的 N 次走子请求返回 429，用于验证限流重试。 */
  failNextMoves(count: number): void;
  close(): Promise<void>;
}

export async function startChessStubServer(): Promise<ChessStubServer> {
  const rooms = new Map<string, StubRoom>();
  let counter = 0;
  let forcedFailures = 0;

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (method === "GET" && path === "/") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && path === "/api/rooms") {
        counter += 1;
        const code = `R${String(counter).padStart(5, "0")}`;
        const playerId = `white-${counter}`;
        const room: StubRoom = {
          code,
          status: "waiting",
          fen: positionToFen(startPosition()),
          turn: "white",
          moves: [],
          whiteId: playerId,
          blackId: "",
          result: null,
        };
        rooms.set(code, room);
        sendJson(res, 200, { code, playerId, color: "white" });
        return;
      }

      const match = /^\/api\/rooms\/([A-Z0-9]+)(?:\/(join|move))?$/.exec(path);
      if (match) {
        const code = match[1]!;
        const action = match[2];
        const room = rooms.get(code);
        if (!room) {
          sendJson(res, 404, { error: "房间不存在" });
          return;
        }

        if (method === "GET" && !action) {
          sendJson(res, 200, roomState(room));
          return;
        }

        if (method === "POST" && action === "join") {
          if (room.blackId) {
            sendJson(res, 409, { error: "房间已满" });
            return;
          }
          room.blackId = `black-${counter}`;
          room.status = "playing";
          sendJson(res, 200, {
            code,
            playerId: room.blackId,
            color: "black",
            room: roomState(room),
          });
          return;
        }

        if (method === "POST" && action === "move") {
          if (forcedFailures > 0) {
            forcedFailures -= 1;
            sendJson(res, 429, { error: "请求过于频繁，请稍后再试" });
            return;
          }
          const body = await readJson(req);
          const playerId = String(body["playerId"] ?? "");
          const from = String(body["from"] ?? "");
          const to = String(body["to"] ?? "");
          const promotion = body["promotion"];

          if (!playerId || !from || !to) {
            sendJson(res, 400, { error: "参数缺失" });
            return;
          }
          if (room.status !== "playing") {
            sendJson(res, 400, { error: "当前不可走子" });
            return;
          }

          const color: ArenaColor | "" =
            playerId === room.whiteId ? "white" : playerId === room.blackId ? "black" : "";
          if (!color) {
            sendJson(res, 400, { error: "玩家不存在" });
            return;
          }
          if (room.turn !== color) {
            sendJson(res, 400, { error: "未轮到您走子" });
            return;
          }

          const position = parseFen(room.fen);
          const wanted = `${from}${to}${typeof promotion === "string" ? promotion : ""}`;
          const legal = generateLegalMoves(position).find((move) => moveId(move) === wanted);
          if (!legal) {
            sendJson(res, 400, { error: "非法走子" });
            return;
          }

          const next = applyMove(position, legal);
          const move: StubMove = {
            moveNumber: room.moves.length + 1,
            san: moveId(legal),
            fen: positionToFen(next),
            from,
            to,
            ...(typeof promotion === "string" ? { promotion } : {}),
            playedBy: color,
          };
          room.moves.push(move);
          room.fen = move.fen;
          room.turn = colorAfter(next.turn);

          const remaining = generateLegalMoves(next);
          if (remaining.length === 0) {
            room.status = "finished";
            const reason = isInCheck(next, next.turn) ? "checkmate" : "stalemate";
            room.result =
              reason === "checkmate"
                ? { winner: next.turn === "w" ? "black" : "white", reason }
                : { winner: null, reason };
          }

          sendJson(res, 200, {
            ok: true,
            move,
            fen: room.fen,
            turn: room.turn,
            gameOver: room.status === "finished",
            ...(room.result ? { result: room.result } : {}),
          });
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
    failNextMoves: (count: number) => {
      forcedFailures = count;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function roomState(room: StubRoom) {
  return {
    code: room.code,
    status: room.status,
    currentFen: room.fen,
    turn: room.turn,
    moves: room.moves,
    gameOver: room.status === "finished",
    ...(room.result ? { result: room.result } : {}),
  };
}

function colorAfter(turn: ChessColor): ArenaColor {
  return turn === "w" ? "white" : "black";
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
