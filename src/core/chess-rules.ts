/**
 * 纯函数内核 · 国际象棋规则
 *
 * 为什么自实现：本项目**不新增运行时依赖**（AGENTS 红线 2.5），
 * 且 Oracle / 适配器必须独立于被测实现（不复用 chess-arena 的 chess.js）。
 *
 * 覆盖范围：走子生成、将军/将死/逼和、王车易位、吃过路兵、升变、FEN 编解码。
 * 不覆盖：三次重复与 50 步等依赖历史的规则 —— 这些交给被测游戏的状态字段。
 */

export type ChessColor = "w" | "b";
export type ChessPieceType = "p" | "n" | "b" | "r" | "q" | "k";
export type PromotionPiece = "q" | "r" | "b" | "n";

export interface ChessPiece {
  readonly color: ChessColor;
  readonly type: ChessPieceType;
}

export interface CastlingRights {
  readonly wK: boolean;
  readonly wQ: boolean;
  readonly bK: boolean;
  readonly bQ: boolean;
}

export interface ChessPosition {
  /** 64 格，索引 0 = a8，索引 63 = h1。 */
  readonly board: readonly (ChessPiece | null)[];
  readonly turn: ChessColor;
  readonly castling: CastlingRights;
  /** 吃过路兵的目标格（无则为 null）。 */
  readonly ep: number | null;
  readonly halfmove: number;
  readonly fullmove: number;
}

export interface ChessMove {
  readonly from: number;
  readonly to: number;
  readonly promotion?: PromotionPiece;
  readonly castle?: "K" | "Q";
  readonly enPassant?: boolean;
}

const FILES = "abcdefgh";
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const KNIGHT_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-2, -1],
  [-2, 1],
  [-1, -2],
  [-1, 2],
  [1, -2],
  [1, 2],
  [2, -1],
  [2, 1],
];

const KING_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

const ROOK_DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

const BISHOP_DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

const PROMOTIONS: readonly PromotionPiece[] = ["q", "r", "b", "n"];

/** 方阵下标 → 代数坐标（如 0 → a8）。 */
export function squareName(index: number): string {
  const row = Math.floor(index / 8);
  const col = index % 8;
  return `${FILES[col]}${8 - row}`;
}

/** 代数坐标 → 方阵下标（如 e2 → 52）。 */
export function squareIndex(name: string): number {
  const file = FILES.indexOf(name[0] ?? "");
  const rank = Number(name[1]);
  if (file < 0 || !Number.isInteger(rank) || rank < 1 || rank > 8) {
    throw new Error(`非法棋格：${name}`);
  }
  return (8 - rank) * 8 + file;
}

/** 动作的稳定标识（如 e2e4 / e7e8q）。 */
export function moveId(move: ChessMove): string {
  return `${squareName(move.from)}${squareName(move.to)}${move.promotion ?? ""}`;
}

/** 解析 FEN。只接受完整 6 段格式。 */
export function parseFen(fen: string): ChessPosition {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 6) throw new Error(`FEN 段数不足：${fen}`);

  const placement = parts[0] ?? "";
  const turn = parts[1];
  const castling = parts[2] ?? "-";
  const ep = parts[3] ?? "-";
  const halfmove = parts[4] ?? "0";
  const fullmove = parts[5] ?? "1";
  if (!placement || (turn !== "w" && turn !== "b")) throw new Error(`FEN 执子方非法：${fen}`);

  const board: (ChessPiece | null)[] = Array.from({ length: 64 }, () => null);
  let row = 0;
  let col = 0;

  for (const ch of placement) {
    if (ch === "/") {
      row += 1;
      col = 0;
      continue;
    }
    if (/[1-8]/.test(ch)) {
      col += Number(ch);
      continue;
    }
    if (!/[prnbqkPRNBQK]/.test(ch)) throw new Error(`FEN 棋子字符非法：${ch}`);
    if (row > 7 || col > 7) throw new Error(`FEN 棋盘越界：${fen}`);
    board[row * 8 + col] = {
      color: ch === ch.toUpperCase() ? "w" : "b",
      type: ch.toLowerCase() as ChessPieceType,
    };
    col += 1;
  }

  if (row !== 7) throw new Error(`FEN 棋盘行数非法：${fen}`);

  return {
    board,
    turn,
    castling: {
      wK: castling.includes("K"),
      wQ: castling.includes("Q"),
      bK: castling.includes("k"),
      bQ: castling.includes("q"),
    },
    ep: ep && ep !== "-" ? squareIndex(ep) : null,
    halfmove: Number(halfmove),
    fullmove: Number(fullmove),
  };
}

/** 序列化为 FEN。ep 的写法与 chess.js 一致：只有存在邻格敌兵时才保留。 */
export function positionToFen(position: ChessPosition): string {
  const rows: string[] = [];
  for (let row = 0; row < 8; row += 1) {
    let line = "";
    let empty = 0;
    for (let col = 0; col < 8; col += 1) {
      const piece = position.board[row * 8 + col] ?? null;
      if (!piece) {
        empty += 1;
        continue;
      }
      if (empty > 0) {
        line += String(empty);
        empty = 0;
      }
      const letter = piece.type;
      line += piece.color === "w" ? letter.toUpperCase() : letter;
    }
    if (empty > 0) line += String(empty);
    rows.push(line);
  }

  const castle =
    `${position.castling.wK ? "K" : ""}${position.castling.wQ ? "Q" : ""}` +
    `${position.castling.bK ? "k" : ""}${position.castling.bQ ? "q" : ""}`;

  return [
    rows.join("/"),
    position.turn,
    castle || "-",
    position.ep === null ? "-" : squareName(position.ep),
    String(position.halfmove),
    String(position.fullmove),
  ].join(" ");
}

/** 初始局面。 */
export function startPosition(): ChessPosition {
  return parseFen(START_FEN);
}

/** 某一方是否被将军。 */
export function isInCheck(position: ChessPosition, color: ChessColor): boolean {
  const king = findKing(position.board, color);
  if (king < 0) return false;
  return isSquareAttacked(position, king, other(color));
}

/** 将死：无合法着且被将军。 */
export function isCheckmate(position: ChessPosition): boolean {
  return generateLegalMoves(position).length === 0 && isInCheck(position, position.turn);
}

/** 逼和：无合法着且未被将军。 */
export function isStalemate(position: ChessPosition): boolean {
  return generateLegalMoves(position).length === 0 && !isInCheck(position, position.turn);
}

/**
 * 生成全部合法着。
 *
 * 顺序固定（按格与目标方向遍历），保证同局面的动作序列可复现。
 */
export function generateLegalMoves(position: ChessPosition): ChessMove[] {
  const mover = position.turn;
  return generatePseudoMoves(position).filter(
    (move) => !isInCheck(applyMove(position, move), mover),
  );
}

/** 应用一步，返回新局面。不会修改入参。 */
export function applyMove(position: ChessPosition, move: ChessMove): ChessPosition {
  const board = position.board.slice();
  const moving = board[move.from] ?? null;
  if (!moving) throw new Error(`起点无棋子：${squareName(move.from)}`);

  const fromRow = Math.floor(move.from / 8);
  const toRow = Math.floor(move.to / 8);
  const toCol = move.to % 8;

  let captured = board[move.to] ?? null;

  if (move.enPassant) {
    // 吃过路兵：被吃掉的兵在起点行、目标列。
    const captureIndex = fromRow * 8 + toCol;
    captured = board[captureIndex] ?? null;
    board[captureIndex] = null;
  }

  board[move.from] = null;

  if (move.castle) {
    const rookFrom = castleRookFrom(moving.color, move.castle);
    const rookTo = castleRookTo(moving.color, move.castle);
    const rook = board[rookFrom] ?? null;
    if (rook) {
      board[rookFrom] = null;
      board[rookTo] = rook;
    }
  }

  const promoted: ChessPiece | null =
    move.promotion && moving.type === "p" ? { color: moving.color, type: move.promotion } : null;
  board[move.to] = promoted ?? moving;

  const castling = nextCastlingRights(position, moving, move.from, captured, move.to);

  let ep: number | null = null;
  if (moving.type === "p" && Math.abs(toRow - fromRow) === 2) {
    const mid = (move.from + move.to) / 2;
    // 与 chess.js 对齐：只有邻格有敌兵（可吃过路兵）时才写 ep。
    if (hasAdjacentPawn(board, toRow, toCol, other(moving.color))) ep = mid;
  }

  const resetHalfmove = moving.type === "p" || captured !== null;

  return {
    board,
    turn: other(position.turn),
    castling,
    ep,
    halfmove: resetHalfmove ? 0 : position.halfmove + 1,
    fullmove: position.turn === "b" ? position.fullmove + 1 : position.fullmove,
  };
}

/** 生成伪合法着（未过滤"走完后自己被将军"）。 */
function generatePseudoMoves(position: ChessPosition): ChessMove[] {
  const moves: ChessMove[] = [];
  const turn = position.turn;

  for (let from = 0; from < 64; from += 1) {
    const piece = position.board[from] ?? null;
    if (!piece || piece.color !== turn) continue;
    const row = Math.floor(from / 8);
    const col = from % 8;

    switch (piece.type) {
      case "p":
        addPawnMoves(position, moves, from, row, col, turn);
        break;
      case "n":
        for (const [dr, dc] of KNIGHT_OFFSETS) {
          const target = offsetIndex(row, col, dr, dc);
          if (target === null) continue;
          const occupant = position.board[target] ?? null;
          if (!occupant || occupant.color !== turn) moves.push({ from, to: target });
        }
        break;
      case "b":
        addSlidingMoves(position, moves, from, row, col, BISHOP_DIRS);
        break;
      case "r":
        addSlidingMoves(position, moves, from, row, col, ROOK_DIRS);
        break;
      case "q":
        addSlidingMoves(position, moves, from, row, col, [...ROOK_DIRS, ...BISHOP_DIRS]);
        break;
      case "k":
        for (const [dr, dc] of KING_OFFSETS) {
          const target = offsetIndex(row, col, dr, dc);
          if (target === null) continue;
          const occupant = position.board[target] ?? null;
          if (!occupant || occupant.color !== turn) moves.push({ from, to: target });
        }
        addCastlingMoves(position, moves, from, turn);
        break;
    }
  }

  return moves;
}

/** 兵的走法（前进、双步、斜吃、吃过路兵、升变）。 */
function addPawnMoves(
  position: ChessPosition,
  moves: ChessMove[],
  from: number,
  row: number,
  col: number,
  color: ChessColor,
): void {
  const dir = color === "w" ? -1 : 1;
  const startRow = color === "w" ? 6 : 1;
  const promoRow = color === "w" ? 0 : 7;

  const one = offsetIndex(row, col, dir, 0);
  if (one !== null && !(position.board[one] ?? null)) {
    addPawnAdvance(moves, from, one, row + dir === promoRow);
    if (row === startRow) {
      const two = offsetIndex(row, col, dir * 2, 0);
      if (two !== null && !(position.board[two] ?? null)) {
        moves.push({ from, to: two });
      }
    }
  }

  for (const dc of [-1, 1]) {
    const target = offsetIndex(row, col, dir, dc);
    if (target === null) continue;
    const occupant = position.board[target] ?? null;
    if (occupant && occupant.color !== color) {
      addPawnAdvance(moves, from, target, row + dir === promoRow);
    } else if (!occupant && position.ep === target) {
      moves.push({ from, to: target, enPassant: true });
    }
  }
}

function addPawnAdvance(moves: ChessMove[], from: number, to: number, promotion: boolean): void {
  if (promotion) {
    for (const piece of PROMOTIONS) moves.push({ from, to, promotion: piece });
  } else {
    moves.push({ from, to });
  }
}

/** 滑行棋子（车/象/后）。 */
function addSlidingMoves(
  position: ChessPosition,
  moves: ChessMove[],
  from: number,
  row: number,
  col: number,
  dirs: ReadonlyArray<readonly [number, number]>,
): void {
  const turn = position.turn;
  for (const [dr, dc] of dirs) {
    let r = row + dr;
    let c = col + dc;
    while (r >= 0 && r < 8 && c >= 0 && c < 8) {
      const target = r * 8 + c;
      const occupant = position.board[target] ?? null;
      if (!occupant) {
        moves.push({ from, to: target });
      } else {
        if (occupant.color !== turn) moves.push({ from, to: target });
        break;
      }
      r += dr;
      c += dc;
    }
  }
}

/** 王车易位：路径空、不过将、起点/中途/终点均不被攻击。 */
function addCastlingMoves(
  position: ChessPosition,
  moves: ChessMove[],
  from: number,
  color: ChessColor,
): void {
  const kingHome = color === "w" ? 60 : 4;
  if (from !== kingHome) return;
  const opponent = other(color);

  if (color === "w" && position.castling.wK) {
    const rook = position.board[63] ?? null;
    if (rook?.type === "r" && rook.color === "w" && isEmpty(position, [61, 62])) {
      if (!attacked(position, [60, 61, 62], opponent)) {
        moves.push({ from, to: 62, castle: "K" });
      }
    }
  }
  if (color === "w" && position.castling.wQ) {
    const rook = position.board[56] ?? null;
    if (rook?.type === "r" && rook.color === "w" && isEmpty(position, [57, 58, 59])) {
      if (!attacked(position, [60, 59, 58], opponent)) {
        moves.push({ from, to: 58, castle: "Q" });
      }
    }
  }
  if (color === "b" && position.castling.bK) {
    const rook = position.board[7] ?? null;
    if (rook?.type === "r" && rook.color === "b" && isEmpty(position, [5, 6])) {
      if (!attacked(position, [4, 5, 6], opponent)) {
        moves.push({ from, to: 6, castle: "K" });
      }
    }
  }
  if (color === "b" && position.castling.bQ) {
    const rook = position.board[0] ?? null;
    if (rook?.type === "r" && rook.color === "b" && isEmpty(position, [1, 2, 3])) {
      if (!attacked(position, [4, 3, 2], opponent)) {
        moves.push({ from, to: 2, castle: "Q" });
      }
    }
  }
}

/** 某个格子是否被 by 方攻击。 */
function isSquareAttacked(position: ChessPosition, target: number, by: ChessColor): boolean {
  const tRow = Math.floor(target / 8);
  const tCol = target % 8;
  const board = position.board;

  // 兵：by=白，攻击者在目标下一行；by=黑，攻击者在目标上一行。
  const pawnRow = tRow + (by === "w" ? 1 : -1);
  for (const dc of [-1, 1]) {
    if (!inside(pawnRow, tCol + dc)) continue;
    const piece = board[pawnRow * 8 + tCol + dc] ?? null;
    if (piece?.color === by && piece.type === "p") return true;
  }

  // 马。
  for (const [dr, dc] of KNIGHT_OFFSETS) {
    if (!inside(tRow + dr, tCol + dc)) continue;
    const piece = board[(tRow + dr) * 8 + tCol + dc] ?? null;
    if (piece?.color === by && piece.type === "n") return true;
  }

  // 王（相邻）。
  for (const [dr, dc] of KING_OFFSETS) {
    if (!inside(tRow + dr, tCol + dc)) continue;
    const piece = board[(tRow + dr) * 8 + tCol + dc] ?? null;
    if (piece?.color === by && piece.type === "k") return true;
  }

  // 车/象/后：沿射线找第一个棋子，若是攻击方的对应棋子则成立。
  const rays: ReadonlyArray<{
    readonly dirs: ReadonlyArray<readonly [number, number]>;
    readonly types: readonly ChessPieceType[];
  }> = [
    { dirs: ROOK_DIRS, types: ["r", "q"] },
    { dirs: BISHOP_DIRS, types: ["b", "q"] },
  ];

  for (const ray of rays) {
    for (const [dr, dc] of ray.dirs) {
      let r = tRow + dr;
      let c = tCol + dc;
      while (inside(r, c)) {
        const piece = board[r * 8 + c] ?? null;
        if (piece) {
          if (piece.color === by && ray.types.includes(piece.type)) return true;
          break;
        }
        r += dr;
        c += dc;
      }
    }
  }

  return false;
}

function attacked(position: ChessPosition, squares: readonly number[], by: ChessColor): boolean {
  return squares.some((square) => isSquareAttacked(position, square, by));
}

function isEmpty(position: ChessPosition, squares: readonly number[]): boolean {
  return squares.every((square) => (position.board[square] ?? null) === null);
}

function nextCastlingRights(
  position: ChessPosition,
  moving: ChessPiece,
  from: number,
  captured: ChessPiece | null,
  to: number,
): CastlingRights {
  const next: { wK: boolean; wQ: boolean; bK: boolean; bQ: boolean } = {
    ...position.castling,
  };

  if (moving.type === "k") {
    if (moving.color === "w") {
      next.wK = false;
      next.wQ = false;
    } else {
      next.bK = false;
      next.bQ = false;
    }
  }

  if (moving.type === "r") {
    clearRookRight(next, moving.color, from);
  }

  if (captured?.type === "r") {
    clearRookRight(next, captured.color, to);
  }

  return next;
}

function clearRookRight(
  rights: { wK: boolean; wQ: boolean; bK: boolean; bQ: boolean },
  color: ChessColor,
  square: number,
): void {
  if (color === "w") {
    if (square === 56) rights.wQ = false;
    if (square === 63) rights.wK = false;
  } else {
    if (square === 0) rights.bQ = false;
    if (square === 7) rights.bK = false;
  }
}

function castleRookFrom(color: ChessColor, side: "K" | "Q"): number {
  if (color === "w") return side === "K" ? 63 : 56;
  return side === "K" ? 7 : 0;
}

function castleRookTo(color: ChessColor, side: "K" | "Q"): number {
  if (color === "w") return side === "K" ? 61 : 59;
  return side === "K" ? 5 : 3;
}

function findKing(board: readonly (ChessPiece | null)[], color: ChessColor): number {
  for (let index = 0; index < 64; index += 1) {
    const piece = board[index] ?? null;
    if (piece?.color === color && piece.type === "k") return index;
  }
  return -1;
}

function hasAdjacentPawn(
  board: readonly (ChessPiece | null)[],
  row: number,
  col: number,
  color: ChessColor,
): boolean {
  for (const dc of [-1, 1]) {
    if (!inside(row, col + dc)) continue;
    const piece = board[row * 8 + col + dc] ?? null;
    if (piece?.color === color && piece.type === "p") return true;
  }
  return false;
}

function other(color: ChessColor): ChessColor {
  return color === "w" ? "b" : "w";
}

function inside(row: number, col: number): boolean {
  return row >= 0 && row < 8 && col >= 0 && col < 8;
}

function offsetIndex(row: number, col: number, dr: number, dc: number): number | null {
  const r = row + dr;
  const c = col + dc;
  return inside(r, c) ? r * 8 + c : null;
}
