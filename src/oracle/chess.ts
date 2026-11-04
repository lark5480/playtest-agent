/**
 * Oracle · 国际象棋游戏特异断言
 *
 * **独立性**：规则计算来自本项目自实现的纯函数内核 `core/chess-rules.ts`，
 * 不复用 chess-arena 的 chess.js —— 理由见 ARCHITECTURE §5（避免共模错误）。
 *
 * 断言清单：
 * - CHS1 服务端接受的走子必须在独立计算的合法着集合里
 * - CHS2 走子后的 FEN 必须与独立推演结果完全一致
 * - CHS3 moveCount 必须 +1
 * - CHS4 回合必须交替（终局则 turn 必须为 null）
 * - CHS5 终局结果必须与棋盘事实一致（将死/逼和/认输/超时）
 * - CHS6 playing 状态不得无合法着（否则对局卡死）
 * - CHS7 走子历史长度必须与 moveCount 一致
 * - CHS8 服务端判 threefold 时，本地历史必须真出现 3 次同一局面
 * - CHS9 服务端判 fifty 时，本地半回合数必须真的达到 100
 * - CHS10 本地历史已判和，服务端却仍在 playing → 漏判
 * - CHS11 和棋原因与"棋盘实际将死"冲突（将死优先于历史型和棋）
 *
 * 关于"连续 60 步将军"：FIDE 没有这条规则，长将由三次重复 / 50 步覆盖，
 * 因此本 Oracle **不设**以"将军次数"为判据的断言。
 */

import {
  analyzeHistory,
  applyMove,
  generateLegalMoves,
  isCheckmate,
  isInCheck,
  moveId,
  parseFen,
  positionToFen,
  squareIndex,
} from "../core/chess-rules.js";
import type { ChessColor, ChessMove, ChessPosition, PromotionPiece } from "../core/chess-rules.js";
import type { Action, Observation } from "../types/game.js";
import type { StepOutcome } from "../types/step.js";

import type { Oracle, OracleViolation } from "./oracle.js";

export class ChessOracle implements Oracle {
  readonly name = "chess";

  assert(params: {
    readonly before: Observation;
    readonly after: Observation | null;
    readonly action: Action | null;
    readonly outcome: StepOutcome;
  }): readonly OracleViolation[] {
    const { before, after, action, outcome } = params;
    const violations: OracleViolation[] = [];

    if (after === null || action === null || outcome !== "applied") {
      return violations;
    }

    const beforeFen = fenOf(before);
    const afterFen = fenOf(after);
    if (!beforeFen || !afterFen) return violations;

    let beforePos;
    try {
      beforePos = parseFen(beforeFen);
      parseFen(afterFen);
    } catch (error) {
      violations.push({
        code: "CHS0-fen-unparseable",
        severity: "fatal",
        message: `服务端返回的 FEN 无法解析：${error instanceof Error ? error.message : String(error)}`,
        stepNo: null,
      });
      return violations;
    }

    const move = actionToMove(action);
    if (!move) return violations;

    // CHS1：动作必须存在于独立生成的合法着集合中
    const legalMoves = generateLegalMoves(beforePos);
    const expected = legalMoves.find((candidate) => moveId(candidate) === moveId(move));
    if (!expected) {
      violations.push({
        code: "CHS1-illegal-move-accepted",
        severity: "fatal",
        message: `服务端接受了非法走子 ${moveId(move)}（该局面合法着：${legalMoves
          .map(moveId)
          .join(",")}）`,
        stepNo: null,
      });
      return violations;
    }

    // CHS2：走子后的 FEN 必须与独立推演一致
    const expectedPos = applyTo(beforePos, expected);
    const expectedFen = positionToFen(expectedPos);
    if (expectedFen !== afterFen) {
      violations.push({
        code: "CHS2-fen-mismatch",
        severity: "fatal",
        message: `走子后 FEN 与独立推演不一致：期望 ${expectedFen}，实际 ${afterFen}`,
        stepNo: null,
      });
    }

    // CHS3：moveCount 必须 +1
    const beforeCount = Number(before.state.payload["moveCount"] ?? 0);
    const afterCount = Number(after.state.payload["moveCount"] ?? 0);
    if (afterCount !== beforeCount + 1) {
      violations.push({
        code: "CHS3-move-count-not-incremented",
        severity: "fatal",
        message: `moveCount 未正确递增：${beforeCount} → ${afterCount}（应 +1）`,
        stepNo: null,
      });
    }

    // CHS4：回合交替
    if (after.state.status === "playing") {
      const expectedTurn = beforePos.turn === "w" ? "black" : "white";
      if (after.state.turn !== expectedTurn) {
        violations.push({
          code: "CHS4-turn-not-alternated",
          severity: "fatal",
          message: `回合未交替：走子前 ${colorName(beforePos.turn)}，走子后应为 "${expectedTurn}"，实际 "${after.state.turn}"`,
          stepNo: null,
        });
      }
    } else if (after.state.turn !== null) {
      violations.push({
        code: "CHS4-finished-turn-not-null",
        severity: "fatal",
        message: `终局状态的 turn 应为 null，实际为 "${after.state.turn}"`,
        stepNo: null,
      });
    }

    // CHS5：终局结果与棋盘事实一致
    if (after.state.status === "finished") {
      violations.push(...this.checkResult(beforePos.turn, expectedPos, after));
    }

    // CHS6：playing 不得无合法着
    if (after.state.status === "playing" && after.state.legalActions.length === 0) {
      violations.push({
        code: "CHS6-playing-without-legal-moves",
        severity: "fatal",
        message: "对局仍为 playing，但当前方无合法着 —— 对局会卡死",
        stepNo: null,
      });
    }

    // CHS7：走子历史长度必须与 moveCount 一致
    const history = movesOf(after);
    if (history && history.length !== afterCount) {
      violations.push({
        code: "CHS7-move-history-length-mismatch",
        severity: "fatal",
        message: `走子历史长度 ${history.length} 与 moveCount ${afterCount} 不一致`,
        stepNo: null,
      });
    }

    // CHS8–CHS10：历史型和棋必须由本地 FEN 历史独立复核
    const fenHistory = fenHistoryOf(after);
    if (fenHistory) {
      const local = analyzeHistory(fenHistory);
      const reason = resultOf(after)?.reason ?? "";

      if (reason === "threefold" && !local.threefold) {
        violations.push({
          code: "CHS8-threefold-without-repetition",
          severity: "fatal",
          message: `result.reason 为 threefold，但本地历史只出现 ${local.repetitionCount} 次同一局面（需 3 次）`,
          stepNo: null,
        });
      }

      if (reason === "fifty" && !local.fiftyMove) {
        violations.push({
          code: "CHS9-fifty-move-clock-below-100",
          severity: "fatal",
          message: `result.reason 为 fifty，但本地半回合数只有 ${local.halfmoveClock}（需 100）`,
          stepNo: null,
        });
      }

      if (after.state.status === "playing" && local.reason !== null) {
        violations.push({
          code: "CHS10-history-draw-missed",
          severity: "fatal",
          message: `本地历史已判定${local.reason}（重复 ${local.repetitionCount} 次 / 半回合 ${local.halfmoveClock}），服务端仍报 playing`,
          stepNo: null,
        });
      }
    }

    return violations;
  }

  /** 终局时校验 result 的 winner/reason 是否与独立推演的棋盘一致。 */
  private checkResult(
    mover: ChessColor,
    board: ReturnType<typeof parseFen>,
    after: Observation,
  ): readonly OracleViolation[] {
    const violations: OracleViolation[] = [];
    const result = resultOf(after);
    if (!result) {
      violations.push({
        code: "CHS5-finished-without-result",
        severity: "fatal",
        message: "对局已 finished，但 payload 中没有 result",
        stepNo: null,
      });
      return violations;
    }

    const winner = result.winner;
    const reason = result.reason;
    const legalMoves = generateLegalMoves(board);
    const checkmated = legalMoves.length === 0 && isInCheck(board, board.turn);

    switch (reason) {
      case "checkmate":
        if (!checkmated) {
          violations.push({
            code: "CHS5-checkmate-without-checkmate",
            severity: "fatal",
            message: "result.reason 为 checkmate，但独立推演显示棋盘不是将死局面",
            stepNo: null,
          });
        }
        if (winner !== colorName(mover)) {
          violations.push({
            code: "CHS5-checkmate-winner-wrong",
            severity: "fatal",
            message: `将死时胜方应为走子方 ${colorName(mover)}，实际为 ${String(winner)}`,
            stepNo: null,
          });
        }
        break;
      case "stalemate":
        if (legalMoves.length !== 0 || isInCheck(board, board.turn)) {
          violations.push({
            code: "CHS5-stalemate-mismatch",
            severity: "fatal",
            message: "result.reason 为 stalemate，但独立推演显示仍有合法着或王被将军",
            stepNo: null,
          });
        }
        if (winner !== null) {
          violations.push({
            code: "CHS5-stalemate-winner-not-null",
            severity: "fatal",
            message: `逼和时 winner 应为 null，实际为 ${String(winner)}`,
            stepNo: null,
          });
        }
        break;
      case "resignation":
      case "timeout":
        // 这两种结果不是走子产生的（本适配器也不提供认输动作），
        // 无法从"最后走子方"推断认输方，因此只要求 winner 是合法颜色。
        if (winner !== "white" && winner !== "black") {
          violations.push({
            code: "CHS5-forfeit-winner-missing",
            severity: "fatal",
            message: `${reason} 时 winner 应为 white/black，实际为 ${String(winner)}`,
            stepNo: null,
          });
        }
        break;
      case "insufficient":
      case "threefold":
      case "fifty":
      case "draw":
        if (winner !== null) {
          violations.push({
            code: "CHS5-draw-winner-not-null",
            severity: "fatal",
            message: `${reason} 时 winner 应为 null，实际为 ${String(winner)}`,
            stepNo: null,
          });
        }
        // CHS11：将死优先于一切历史型和棋，棋盘事实上已无合法着且被将军时不能判和
        if (isCheckmate(board)) {
          violations.push({
            code: "CHS11-draw-vs-checkmate",
            severity: "fatal",
            message: `result.reason 为 ${reason}，但棋盘事实是将死 —— 将死应立即终局，不能被历史型和棋覆盖`,
            stepNo: null,
          });
        }
        break;
      default:
        break;
    }

    return violations;
  }
}

// ---------------------------------------------------------------- 辅助

function fenOf(observation: Observation): string | null {
  const fen = observation.state.payload["fen"];
  return typeof fen === "string" ? fen : null;
}

function movesOf(observation: Observation): readonly string[] | null {
  const raw = observation.state.payload["moves"];
  if (!Array.isArray(raw)) return null;
  return raw.filter((item): item is string => typeof item === "string");
}

function fenHistoryOf(observation: Observation): readonly string[] | null {
  const raw = observation.state.payload["fenHistory"];
  if (!Array.isArray(raw)) return null;
  const list = raw.filter((item): item is string => typeof item === "string");
  return list.length > 0 ? list : null;
}

function resultOf(
  observation: Observation,
): { readonly winner: string | null; readonly reason: string } | null {
  const raw = observation.state.payload["result"];
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const winner = record["winner"];
  const reason = record["reason"];
  if (reason !== undefined && typeof reason !== "string") return null;
  return {
    winner: winner === "white" || winner === "black" ? winner : null,
    reason: typeof reason === "string" ? reason : "",
  };
}

function actionToMove(action: Action): ChessMove | null {
  const from = action.payload["from"];
  const to = action.payload["to"];
  if (typeof from !== "string" || typeof to !== "string") return null;

  try {
    const move: ChessMove = {
      from: squareIndex(from),
      to: squareIndex(to),
    };
    const promotion = action.payload["promotion"];
    if (typeof promotion === "string" && isPromotion(promotion)) {
      return { ...move, promotion };
    }
    return move;
  } catch {
    return null;
  }
}

function isPromotion(value: string): value is PromotionPiece {
  return value === "q" || value === "r" || value === "b" || value === "n";
}

/**
 * 独立推演一步。这里直接调用 core 的 applyMove；
 * 为保持 Oracle 与适配器的可读边界，单独包一层便于将来替换实现。
 */
function applyTo(position: ChessPosition, move: ChessMove): ChessPosition {
  return applyMove(position, move);
}

function colorName(color: ChessColor): "white" | "black" {
  return color === "w" ? "white" : "black";
}
