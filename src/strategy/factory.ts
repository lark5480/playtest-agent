import { HeuristicStrategy } from "./heuristic.js";
import { LlmStrategy, type LlmClient } from "./llm.js";
import type { Strategy } from "./strategy.js";

export function createStrategy(
  kind: "auto" | "heuristic" | "llm" | "llm-explore",
  client: LlmClient | null,
): Strategy {
  return kind === "heuristic"
    ? new HeuristicStrategy()
    : new LlmStrategy(client, 60_000, kind === "llm-explore" ? "llm-explore" : "llm");
}
