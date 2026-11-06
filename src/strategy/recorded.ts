import { canonicalize } from "../core/fingerprint.js";
import { publicSnapshot, snapshotHash } from "../core/recording.js";
import type { ReportJson } from "../core/report-core.js";
import type { Decision, Observation } from "../types/game.js";
import { StrategyStop } from "../types/run.js";
import type { Strategy } from "./strategy.js";

export class RecordedStrategy implements Strategy {
  readonly name = "recorded";

  constructor(private readonly recording: ReportJson) {}

  async decide({ observation }: { observation: Observation; seed: number }): Promise<Decision> {
    const step = this.recording.steps[observation.seq];
    if (!step) throw new StrategyStop("recording-exhausted", "录制动作已全部执行");
    const current = publicSnapshot(this.recording.metadata.game, observation.state);
    if (snapshotHash(current) !== step.beforeHash) {
      throw new StrategyStop("state-diverged", "当前局面与录制前态不一致");
    }
    const action = step.action;
    const chosen = observation.state.legalActions.find(
      (candidate) =>
        candidate.id === action?.id &&
        JSON.stringify(canonicalize(candidate.payload)) ===
          JSON.stringify(canonicalize(action.payload)),
    );
    if (!chosen) throw new StrategyStop("state-diverged", "录制动作在当前局面不合法");
    return { action: chosen, reason: "执行已录制动作，不调用模型", degraded: false };
  }
}
