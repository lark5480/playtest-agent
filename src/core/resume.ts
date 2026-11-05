/**
 * 纯函数 · 续跑判定
 *
 * 崩在「动作已生效、检查点未提交」的窗口时，恢复方必须判断该动作到底生效没有。
 * 三分支：
 * - `replayed`：当前状态 == 预期的 after → 动作已生效，不重复执行；
 * - `redo`：当前状态 == before → 动作未生效，用**同一个动作**重做；
 * - `diverged`：两者都不是 → 状态发散，显式失败（不猜）。
 */

export type ResumeDecision = "replayed" | "redo" | "diverged";

export function decideResumeAction(params: {
  readonly currentHash: string;
  readonly beforeHash: string;
  readonly expectedAfterHash?: string;
}): ResumeDecision {
  if (params.expectedAfterHash !== undefined && params.currentHash === params.expectedAfterHash) {
    return "replayed";
  }
  if (params.currentHash === params.beforeHash) {
    return "redo";
  }
  return "diverged";
}
