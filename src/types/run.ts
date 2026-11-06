import type { Action, GameState } from "./game.js";

export type GameKind = "othello" | "chess";

export type StopReason =
  | "game-finished"
  | "step-limit"
  | "budget-limit"
  | "assertion-failed"
  | "execution-failed"
  | "strategy-stopped"
  | "stalled"
  | "recording-exhausted"
  | "state-diverged";

export type ErrorCategory = "governance" | "game" | "strategy" | "budget" | "state";

export interface RunMetadata {
  readonly game: GameKind;
  readonly adapter: string;
  readonly oracle: string;
  readonly strategy: string;
  readonly agentVersion: string;
  readonly targetVersion: string;
  readonly source: "local-service" | "injected-fixture" | "healthy-fixture";
  readonly maxSteps: number;
  readonly target?: string;
  readonly promptVersion?: string;
}

export interface PublicSnapshot {
  readonly status: GameState["status"];
  readonly turn: string | null;
  readonly legalActions: readonly Action[];
  readonly payload: Readonly<Record<string, unknown>>;
}

export class StrategyStop extends Error {
  constructor(
    public readonly stopReason: "budget-limit" | "recording-exhausted" | "state-diverged",
    message: string,
  ) {
    super(message);
    this.name = "StrategyStop";
  }
}
