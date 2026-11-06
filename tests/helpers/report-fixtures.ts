import { buildReportJson } from "../../src/core/report-core.js";
import { digestOf } from "../../src/core/fingerprint.js";
import type { Finding } from "../../src/core/report-core.js";
import type { GameState } from "../../src/types/game.js";
import type { StepRecord } from "../../src/types/step.js";
import type { RunMetadata } from "../../src/types/run.js";

export const metadata: RunMetadata = {
  game: "othello",
  adapter: "othello-local",
  oracle: "othello-oracle",
  strategy: "heuristic",
  agentVersion: "agent-test-v2",
  targetVersion: "fixture-v1",
  source: "local-service",
  maxSteps: 60,
};
export function opening(): GameState {
  const board = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
  board[3]![3] = 2;
  board[3]![4] = 1;
  board[4]![3] = 1;
  board[4]![4] = 2;
  return {
    id: "room1",
    status: "playing",
    turn: "black",
    legalActions: [
      [2, 3],
      [3, 2],
      [4, 5],
      [5, 4],
    ].map(([row, col]) => ({ id: `${row},${col}`, payload: { row, col } })),
    payload: { board, moveCount: 0, winner: null, seq: 0 },
  };
}
export function afterMove(faulty = false): GameState {
  const state = opening();
  const board = state.payload["board"] as number[][];
  board[2]![3] = 1;
  board[3]![3] = faulty ? 2 : 1;
  return {
    ...state,
    turn: "white",
    legalActions: [
      [2, 2],
      [2, 4],
      [4, 2],
    ].map(([row, col]) => ({ id: `${row},${col}`, payload: { row, col } })),
    payload: { board, moveCount: 1, winner: null },
  };
}
export function finished(): GameState {
  return {
    id: "room1",
    status: "finished",
    turn: null,
    legalActions: [],
    payload: {
      board: Array.from({ length: 8 }, () => Array<number>(8).fill(1)),
      moveCount: 60,
      winner: "black",
    },
  };
}
export function step(over: Partial<StepRecord> = {}): StepRecord {
  const record: StepRecord = {
    stepNo: 0,
    fingerprint: { businessKey: "room1", session: "s1", stepNo: 0, digest: "" },
    observation: { state: opening(), seq: 0, at: 1 },
    action: { id: "2,3", payload: { row: 2, col: 3 } },
    reason: "baseline",
    degraded: false,
    outcome: "applied",
    observationAfter: { state: afterMove(), seq: 1, at: 2 },
    governance: { replayed: false, elapsedMs: 3 },
    elapsedMs: 5,
    ...over,
  };
  return {
    ...record,
    fingerprint: {
      ...record.fingerprint,
      stepNo: record.stepNo,
      digest: digestOf(record.action, record.stepNo),
    },
  };
}
export type ReportParams = Parameters<typeof buildReportJson>[0];
export function params(over: Partial<ReportParams> = {}): ReportParams {
  return {
    scenario: "smoke",
    session: "s1",
    businessKey: "room1",
    seed: 42,
    startedAt: 1,
    finishedAt: 2,
    metadata,
    initialState: opening(),
    finalState: afterMove(),
    stopReason: "step-limit",
    gameTerminal: false,
    steps: [step()],
    findings: [],
    governanceSource: "in-memory",
    ...over,
  };
}
export const finding: Finding = {
  code: "OTH2-board-projection-mismatch",
  severity: "fatal",
  message: "独立推演不一致",
  stepNo: 0,
  evidence: [{ field: "board[3][3]", expected: 1, actual: 2 }],
};
export function faultyReport() {
  const state = afterMove(true);
  return buildReportJson(
    params({
      metadata: { ...metadata, source: "injected-fixture" },
      finalState: state,
      steps: [step({ observationAfter: { state, seq: 1, at: 2 } })],
      stopReason: "assertion-failed",
      findings: [finding],
    }),
  );
}
export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
export const AFTER_FEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
export function chessState(): GameState {
  return {
    id: "chess-room",
    status: "playing",
    turn: "white",
    legalActions: [{ id: "e2e4", payload: { from: "e2", to: "e4" } }],
    payload: { fen: START_FEN, moveCount: 0, moves: [], fenHistory: [START_FEN], result: null },
  };
}
export function chessReport() {
  const before = chessState();
  const after: GameState = {
    ...before,
    turn: "black",
    legalActions: [{ id: "e7e5", payload: { from: "e7", to: "e5" } }],
    payload: {
      fen: AFTER_FEN,
      moveCount: 1,
      moves: ["e4"],
      fenHistory: [START_FEN, AFTER_FEN],
      result: null,
    },
  };
  return buildReportJson(
    params({
      metadata: { ...metadata, game: "chess", adapter: "chess-arena", oracle: "chess-oracle" },
      initialState: before,
      finalState: after,
      steps: [
        step({
          observation: { state: before, seq: 0, at: 1 },
          observationAfter: { state: after, seq: 1, at: 2 },
          action: before.legalActions[0]!,
        }),
      ],
    }),
  );
}
