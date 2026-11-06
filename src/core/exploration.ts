import type {
  ExplorationContext,
  ExplorationEvent,
  ExplorationEventMetric,
  ExplorationMetrics,
  GameState,
} from "../types/game.js";
import type { GameKind, PublicSnapshot } from "../types/run.js";
import type { StepRecord } from "../types/step.js";
import { hashOf } from "./state-hash.js";

type State = GameState | PublicSnapshot;
const EVENTS: readonly ExplorationEvent[] = ["corner", "pass", "terminal"];
const RECENT_LIMIT = 6;

/** FEN 全回合数是纯步序；半回合数影响 50 步规则，必须保留。 */
function fenWithoutMoveNumber(fen: unknown): unknown {
  return typeof fen === "string" ? fen.trim().split(/\s+/).slice(0, 5).join(" ") : null;
}

/** 重复判定依赖历史出现次数，不依赖房间、时钟、SAN 展示或纯步序。 */
function repetitionCounts(raw: unknown): readonly (readonly [string, number])[] {
  const counts = new Map<string, number>();
  if (Array.isArray(raw)) {
    for (const fen of raw) {
      if (typeof fen !== "string") continue;
      const key = fen.trim().split(/\s+/).slice(0, 4).join(" ");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 探索去重不是续跑身份：只投影已支持游戏中影响规则的状态。 */
function explorationHash(game: GameKind, state: State): string {
  const payload = state.payload;
  return hashOf({
    game,
    status: state.status,
    turn: state.turn,
    legalActions: state.legalActions.map((action) => hashOf(action)).sort(),
    ...(game === "othello"
      ? {
          board: payload["board"],
          winner: payload["winner"] ?? null,
          consecutivePasses: payload["consecutivePasses"],
        }
      : {
          fen: fenWithoutMoveNumber(payload["fen"]),
          repetitions: repetitionCounts(payload["fenHistory"]),
          result: payload["result"] ?? null,
        }),
  });
}

function boardOf(state: State): readonly (readonly number[])[] | null {
  const board = state.payload["board"];
  return Array.isArray(board) &&
    board.length === 8 &&
    board.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 8 &&
        row.every((cell) => cell === 0 || cell === 1 || cell === 2),
    )
    ? (board as number[][])
    : null;
}

/** 只观察真实 before/after；不投影走子，不复制合法着/翻子规则。 */
function eventsOf(game: GameKind, step: StepRecord): ExplorationEvent[] {
  if (
    game !== "othello" ||
    !step.observationAfter ||
    !step.action ||
    (step.outcome !== "applied" && step.outcome !== "replayed")
  )
    return [];
  const before = step.observation.state;
  const after = step.observationAfter.state;
  if (!before.legalActions.some((action) => hashOf(action) === hashOf(step.action))) return [];
  const events: ExplorationEvent[] = [];
  const boardBefore = boardOf(before);
  const boardAfter = boardOf(after);
  if (boardBefore && boardAfter) {
    const changed = hashOf(boardBefore) !== hashOf(boardAfter);
    const corners = [
      [0, 0],
      [0, 7],
      [7, 0],
      [7, 7],
    ] as const;
    if (corners.some(([row, col]) => boardBefore[row]![col] === 0 && boardAfter[row]![col] !== 0)) {
      events.push("corner");
    }
    // othello 服务自动跳过对手时：落子确实生效，仍由同一方行动。
    const automaticPass =
      changed &&
      before.status === "playing" &&
      after.status === "playing" &&
      before.turn !== null &&
      before.turn === after.turn;
    // 如未来适配器暴露显式 pass，也必须在真实合法集内且状态表明已跳过。
    const explicitPass =
      !changed &&
      step.action.id === "pass" &&
      before.status === "playing" &&
      before.turn !== null &&
      after.turn !== before.turn &&
      (after.status === "playing" || after.status === "finished");
    if (automaticPass || explicitPass) events.push("pass");
  }
  if (before.status !== "finished" && after.status === "finished") events.push("terminal");
  return events;
}

function visitedStates(
  game: GameKind,
  initialState: State | null,
  steps: readonly StepRecord[],
): string[] {
  const visited = initialState ? [explorationHash(game, initialState)] : [];
  for (const step of steps) {
    visited.push(explorationHash(game, step.observation.state));
    if (step.observationAfter) visited.push(explorationHash(game, step.observationAfter.state));
  }
  return visited;
}

export function explorationMetrics(
  game: GameKind,
  initialState: State | null,
  steps: readonly StepRecord[],
): ExplorationMetrics {
  const observed = steps.map((step) => ({ stepNo: step.stepNo, events: eventsOf(game, step) }));
  const metric = (event: ExplorationEvent): ExplorationEventMetric => {
    if (game !== "othello") return { status: "not-applicable" };
    const hits = observed.filter((step) => step.events.includes(event));
    return { status: "applicable", count: hits.length, firstStep: hits[0]?.stepNo ?? null };
  };
  return {
    uniqueStates: new Set(visitedStates(game, initialState, steps)).size,
    events: { corner: metric("corner"), pass: metric("pass"), terminal: metric("terminal") },
  };
}

export function explorationContext(
  game: GameKind,
  target: string,
  steps: readonly StepRecord[],
): ExplorationContext {
  const metrics = explorationMetrics(game, null, steps);
  const visited = [...new Set(visitedStates(game, null, steps))];
  return {
    target,
    visited: { uniqueStates: metrics.uniqueStates, recent: visited.slice(-RECENT_LIMIT) },
    events: metrics.events,
    recent: steps.slice(-RECENT_LIMIT).map((step) => ({
      stepNo: step.stepNo,
      actionId: step.action?.id ?? null,
      outcome: step.outcome,
      stateChanged: step.observationAfter
        ? explorationHash(game, step.observation.state) !==
          explorationHash(game, step.observationAfter.state)
        : null,
      events: EVENTS.filter((event) => eventsOf(game, step).includes(event)),
    })),
  };
}
