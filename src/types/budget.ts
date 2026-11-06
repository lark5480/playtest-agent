export interface ModelAttempt {
  readonly callId: number;
  readonly state: "in-flight" | "settled" | "unknown";
  readonly tokens?: number;
}

export interface ModelBudgetState {
  readonly maxCalls: number;
  readonly tokenLimit?: number;
  readonly attempts: readonly ModelAttempt[];
}

export interface RunBudget {
  snapshot(): ModelBudgetState;
  bindPersistence(save: () => void): void;
}
