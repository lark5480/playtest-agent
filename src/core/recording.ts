/** 唯一公开 JSON 边界。只重建白名单 DTO；错误不回显输入或原始响应。 */
import { createHash } from "node:crypto";
import type { ModelBudgetState } from "../types/budget.js";
import type { Action, GameState } from "../types/game.js";
import type { GameKind, PublicSnapshot, RunMetadata } from "../types/run.js";
import type { TokenSource } from "../types/step.js";
import { canonicalize, digestOf } from "./fingerprint.js";
import { deriveReportResult, summarizeUsage } from "./report-core.js";
import type { Finding, ReportJson, ReportUsage, StepJson } from "./report-core.js";

const MAX_STEPS = 10_000;
const MAX_TOKENS = 1_000_000_000_000;
const SOURCES = ["model-usage", "governance-usage", "synthetic", "unavailable"] as const;
const STOP_REASONS = [
  "game-finished",
  "step-limit",
  "budget-limit",
  "assertion-failed",
  "execution-failed",
  "strategy-stopped",
  "stalled",
  "recording-exhausted",
  "state-diverged",
] as const;
const RESULT_REASONS = [
  "checkmate",
  "stalemate",
  "resignation",
  "timeout",
  "insufficient",
  "threefold",
  "fifty",
  "draw",
] as const;

function invalid(field: string): never {
  throw new Error(`报告 v2 校验失败：${field}`);
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(field);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(field);
  // 拒绝 getter / toJSON 等可执行属性；不会遍历或调用不受信任的扩展字段。
  if (
    Object.values(Object.getOwnPropertyDescriptors(value)).some((entry) => entry.get || entry.set)
  )
    invalid(field);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, max = 200): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    invalid(field);
  return value;
}
function identifier(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^[\p{L}\p{N}_.:@/+ -]+$/u.test(result)) invalid(field);
  return result;
}
function number(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    invalid(field);
  return value;
}
function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(field);
  return value;
}
function enumeration<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) invalid(field);
  return value as T;
}
function list(value: unknown, field: string, max: number): unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    invalid(field);
  if (
    Object.values(Object.getOwnPropertyDescriptors(value)).some((entry) => entry.get || entry.set)
  )
    invalid(field);
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) invalid(field);
  return value;
}
function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}
function nullableColor(value: unknown, field: string): "white" | "black" | null {
  return value === null ? null : enumeration(value, ["white", "black"] as const, field);
}
function board(value: unknown): number[][] {
  const rows = list(value, "snapshot.board", 8);
  if (rows.length !== 8) invalid("snapshot.board");
  return rows.map((row) => {
    const cells = list(row, "snapshot.board.row", 8);
    if (cells.length !== 8) invalid("snapshot.board.row");
    return cells.map((cell) => number(cell, "snapshot.board.cell", 2));
  });
}
/** 仅验证 FEN 语法与尺寸；合法性仍由独立 Oracle 裁决，不新增棋类引擎。 */
function fen(value: unknown): string {
  const result = text(value, "snapshot.fen", 160);
  const parts = result.split(" ");
  if (parts.length !== 6) invalid("snapshot.fen");
  const rows = parts[0]!.split("/");
  if (
    rows.length !== 8 ||
    rows.some(
      (row) =>
        !/^[prnbqkPRNBQK1-8]+$/.test(row) ||
        [...row].reduce((sum, cell) => sum + (/^[1-8]$/.test(cell) ? Number(cell) : 1), 0) !== 8,
    )
  )
    invalid("snapshot.fen.board");
  if (
    !/^[wb]$/.test(parts[1]!) ||
    !/^(?:-|K?Q?k?q?)$/.test(parts[2]!) ||
    !parts[2] ||
    !/^(?:-|[a-h][36])$/.test(parts[3]!) ||
    !/^\d{1,6}$/.test(parts[4]!) ||
    !/^\d{1,6}$/.test(parts[5]!)
  )
    invalid("snapshot.fen.fields");
  number(Number(parts[4]), "snapshot.fen.halfmove", 100_000);
  number(Number(parts[5]), "snapshot.fen.fullmove", 100_000, 1);
  return result;
}
function san(value: unknown): string {
  const result = text(value, "snapshot.moves", 24);
  if (
    !/^(?:(?:O-O(?:-O)?)|(?:[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?))[+#]?[!?]{0,2}$/.test(
      result,
    )
  )
    invalid("snapshot.moves.SAN");
  return result;
}
function chessResult(value: unknown): { winner: "white" | "black" | null; reason: string } | null {
  if (value === null) return null;
  const raw = object(value, "snapshot.result");
  return {
    winner: nullableColor(raw["winner"], "snapshot.result.winner"),
    reason: enumeration(raw["reason"], RESULT_REASONS, "snapshot.result.reason"),
  };
}

export function publicAction(game: GameKind, value: unknown): Action {
  const raw = object(value, "action");
  const payload = object(raw["payload"], "action.payload");
  const id = text(raw["id"], "action.id", 8);
  if (game === "othello") {
    const row = number(payload["row"], "action.row", 7);
    const col = number(payload["col"], "action.col", 7);
    if (id !== `${row},${col}`) invalid("action.id/payload 不一致");
    return { id, payload: { row, col } };
  }
  if (game !== "chess") invalid("metadata.game");
  const from = text(payload["from"], "action.from", 2);
  const to = text(payload["to"], "action.to", 2);
  if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to) || from === to)
    invalid("action.square");
  const promotion =
    payload["promotion"] === undefined
      ? undefined
      : enumeration(payload["promotion"], ["q", "r", "b", "n"], "action.promotion");
  if (id !== `${from}${to}${promotion ?? ""}`) invalid("action.id/payload 不一致");
  return { id, payload: { from, to, ...(promotion ? { promotion } : {}) } };
}

function parseSnapshot(game: GameKind, value: unknown): PublicSnapshot {
  const raw = object(value, "snapshot");
  const payload = object(raw["payload"], "snapshot.payload");
  const status = enumeration(raw["status"], ["waiting", "playing", "finished"], "snapshot.status");
  const turn = nullableColor(raw["turn"], "snapshot.turn");
  const legalActions = list(
    raw["legalActions"],
    "snapshot.legalActions",
    game === "othello" ? 64 : 256,
  ).map((action) => publicAction(game, action));
  if (new Set(legalActions.map((action) => action.id)).size !== legalActions.length)
    invalid("snapshot.legalActions 重复");
  legalActions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (game === "othello") {
    return {
      status,
      turn,
      legalActions,
      payload: {
        board: board(payload["board"]),
        moveCount: number(payload["moveCount"], "snapshot.moveCount", 64),
        winner:
          payload["winner"] === null
            ? null
            : enumeration(payload["winner"], ["white", "black", "draw"], "snapshot.winner"),
      },
    };
  }
  if (game !== "chess") invalid("metadata.game");
  return {
    status,
    turn,
    legalActions,
    payload: {
      fen: fen(payload["fen"]),
      moveCount: number(payload["moveCount"], "snapshot.moveCount", MAX_STEPS),
      moves: list(payload["moves"], "snapshot.moves", MAX_STEPS).map(san),
      fenHistory: list(payload["fenHistory"], "snapshot.fenHistory", MAX_STEPS + 1).map(fen),
      result: chessResult(payload["result"]),
    },
  };
}

export function publicSnapshot(game: GameKind, state: GameState): PublicSnapshot {
  return parseSnapshot(game, state);
}

/** 完整回放摘要，不复用 resume 的窄摘要。房间、时钟、seq 与凭证均不参与。 */
export function snapshotHash(snapshot: PublicSnapshot): string {
  const raw = object(snapshot, "snapshot");
  const payload = object(raw["payload"], "snapshot.payload");
  const game: GameKind = Object.hasOwn(payload, "board") ? "othello" : "chess";
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalize({ schemaVersion: 2, game, snapshot: parseSnapshot(game, snapshot) }),
      ),
      "utf8",
    )
    .digest("hex");
}

function metadataOf(value: unknown): RunMetadata {
  const raw = object(value, "metadata");
  return {
    game: enumeration(raw["game"], ["othello", "chess"], "metadata.game"),
    adapter: identifier(raw["adapter"], "metadata.adapter"),
    oracle: identifier(raw["oracle"], "metadata.oracle"),
    strategy: identifier(raw["strategy"], "metadata.strategy"),
    agentVersion: identifier(raw["agentVersion"], "metadata.agentVersion"),
    targetVersion: identifier(raw["targetVersion"], "metadata.targetVersion"),
    source: enumeration(
      raw["source"],
      ["local-service", "injected-fixture", "healthy-fixture"],
      "metadata.source",
    ),
    maxSteps: number(raw["maxSteps"], "metadata.maxSteps", MAX_STEPS),
    ...(raw["target"] === undefined
      ? {}
      : { target: identifier(raw["target"], "metadata.target") }),
    ...(raw["promptVersion"] === undefined
      ? {}
      : { promptVersion: identifier(raw["promptVersion"], "metadata.promptVersion") }),
  };
}
function budgetOf(value: unknown): ModelBudgetState {
  const raw = object(value, "budget");
  const maxCalls = number(raw["maxCalls"], "budget.maxCalls", MAX_STEPS);
  let previous = -1;
  const attempts = list(raw["attempts"], "budget.attempts", maxCalls).map((value, index, all) => {
    const attempt = object(value, "budget.attempt");
    const callId = number(attempt["callId"], "budget.callId", MAX_STEPS);
    if (callId <= previous) invalid("budget.callId 顺序或重复");
    previous = callId;
    const state = enumeration(
      attempt["state"],
      ["in-flight", "settled", "unknown"],
      "budget.attempt.state",
    );
    if (state === "in-flight" && index !== all.length - 1) invalid("budget.in-flight 顺序");
    const tokens =
      attempt["tokens"] === undefined
        ? undefined
        : number(attempt["tokens"], "budget.tokens", MAX_TOKENS);
    if (state !== "settled" && tokens !== undefined) invalid("budget.unknown tokens");
    return { callId, state, ...(tokens === undefined ? {} : { tokens }) };
  });
  return {
    maxCalls,
    attempts,
    ...(raw["tokenLimit"] === undefined
      ? {}
      : { tokenLimit: number(raw["tokenLimit"], "budget.tokenLimit", MAX_TOKENS) }),
  };
}

/** Evidence 也只允许规则字段；不能借 expected/actual 携带任意响应对象。 */
function evidenceValue(game: GameKind, field: string, value: unknown): unknown {
  const key = field.replace(/^payload\./, "");
  if (key === "status")
    return enumeration(value, ["waiting", "playing", "finished"], "evidence.status");
  if (key === "turn") return nullableColor(value, "evidence.turn");
  if (
    key === "moveCount" ||
    key === "moves.length" ||
    key === "fenHistory.length" ||
    key === "legalActions.length"
  )
    return number(value, "evidence.count", MAX_STEPS + 1);
  if (key === "legalActions")
    return list(value, "evidence.legalActions", 256).map((item) =>
      typeof item === "string" ? actionId(game, item) : publicAction(game, item),
    );
  if (game === "othello") {
    if (key === "board") return board(value);
    if (/^board\[[0-7]\]\[[0-7]\]$/.test(key) || /^board\.[0-7]\.[0-7]$/.test(key))
      return number(value, "evidence.board.cell", 2);
    if (key === "winner")
      return value === null
        ? null
        : enumeration(value, ["white", "black", "draw"], "evidence.winner");
  } else {
    if (key === "fen") return fen(value);
    if (key === "fenHistory") return list(value, "evidence.fenHistory", MAX_STEPS + 1).map(fen);
    if (key === "moves") return list(value, "evidence.moves", MAX_STEPS).map(san);
    if (key === "result") return chessResult(value);
    if (key === "result.winner") return nullableColor(value, "evidence.result.winner");
    if (key === "result.reason")
      return enumeration(value, RESULT_REASONS, "evidence.result.reason");
  }
  invalid("evidence.field 不支持的公开字段");
}
function actionId(game: GameKind, value: string): string {
  if (!(game === "othello" ? /^[0-7],[0-7]$/ : /^[a-h][1-8][a-h][1-8][qrbn]?$/).test(value))
    invalid("evidence.actionId");
  return value;
}
function findingOf(game: GameKind, value: unknown, stepCount: number): Finding {
  const raw = object(value, "finding");
  const code = identifier(raw["code"], "finding.code");
  const severity = enumeration(raw["severity"], ["fatal", "warning"], "finding.severity");
  const stepNo =
    raw["stepNo"] === null ? null : number(raw["stepNo"], "finding.stepNo", stepCount - 1);
  text(raw["message"], "finding.message", 16_384);
  // Oracle 文本可能插值了原始响应。只公开稳定分类；差异值走下面独立白名单。
  const descriptions: Record<string, string> = {
    "OTH2-board-projection-mismatch": "落子后棋盘与独立 Oracle 推演不一致",
    "CHS2-fen-projection-mismatch": "走子后 FEN 与独立 Oracle 推演不一致",
  };
  const message = Object.hasOwn(descriptions, code)
    ? descriptions[code]!
    : "Oracle 报告违规；详见编号与结构化证据";
  const evidence =
    raw["evidence"] === undefined
      ? undefined
      : list(raw["evidence"], "finding.evidence", 256).map((value) => {
          const entry = object(value, "evidence");
          const field = text(entry["field"], "evidence.field", 80);
          return {
            field,
            expected: evidenceValue(game, field, entry["expected"]),
            actual: evidenceValue(game, field, entry["actual"]),
          };
        });
  return { code, severity, message, stepNo, ...(evidence === undefined ? {} : { evidence }) };
}

function sourceList(value: unknown): TokenSource[] {
  const sources = list(value, "tokenSources", 4).map((source) =>
    enumeration(source, SOURCES, "tokenSources"),
  );
  if (new Set(sources).size !== sources.length) invalid("tokenSources 重复");
  return sources.sort();
}
function stepOf(game: GameKind, value: unknown, index: number): StepJson {
  const raw = object(value, "step");
  const stepNo = number(raw["stepNo"], "step.stepNo", MAX_STEPS);
  if (stepNo !== index) invalid("steps 必须从 0 连号");
  const action = raw["action"] === null ? null : publicAction(game, raw["action"]);
  if (raw["actionId"] !== (action?.id ?? null)) invalid("step.actionId/action 不一致");
  const before = parseSnapshot(game, raw["before"]);
  const after = raw["after"] === null ? null : parseSnapshot(game, raw["after"]);
  const beforeHash = snapshotHash(before);
  const afterHash = after === null ? null : snapshotHash(after);
  if (raw["beforeHash"] !== beforeHash || raw["afterHash"] !== afterHash)
    invalid("step.snapshot hash 不一致");
  if (action && !before.legalActions.some((candidate) => equal(candidate, action)))
    invalid("step.action 不在已记录合法动作集中");
  const digest = text(raw["digest"], "step.digest", 32);
  if (digest !== digestOf(action, stepNo)) invalid("step.action digest 不一致");
  const outcome = enumeration(
    raw["outcome"],
    ["applied", "replayed", "rejected", "failed"],
    "step.outcome",
  );
  const degraded = bool(raw["degraded"], "step.degraded");
  const replayed = bool(raw["replayed"], "step.replayed");
  const tokenSources =
    raw["tokenSources"] === undefined ? undefined : sourceList(raw["tokenSources"]);
  const llmTokens =
    raw["llmTokens"] === undefined
      ? undefined
      : number(raw["llmTokens"], "step.llmTokens", MAX_TOKENS);
  const governanceTokens =
    raw["governanceTokens"] === undefined
      ? undefined
      : number(raw["governanceTokens"], "step.governanceTokens", MAX_TOKENS);
  if (llmTokens !== undefined && !tokenSources?.includes("model-usage"))
    invalid("step.llmTokens 来源缺失");
  const governanceSources =
    tokenSources?.filter((source) => source === "synthetic" || source === "governance-usage") ?? [];
  if (
    governanceSources.length > 1 ||
    (governanceTokens !== undefined && governanceSources.length !== 1)
  )
    invalid("step.governanceTokens 来源不明确");
  for (const key of ["error", "degradedReason", "tokensUnavailableReason"])
    if (raw[key] !== undefined) text(raw[key], `step.${key}`, 16_384);
  return {
    stepNo,
    actionId: action?.id ?? null,
    action,
    before,
    after,
    beforeHash,
    afterHash,
    outcome,
    degraded,
    replayed,
    digest,
    elapsedMs: number(raw["elapsedMs"], "step.elapsedMs", 604_800_000),
    ...(degraded ? { degradedReason: "模型不可用或输出无效，已降级到确定性基线" } : {}),
    ...(raw["error"] === undefined ? {} : { error: "执行失败；原始错误文本已省略" }),
    ...(raw["traceId"] === undefined
      ? {}
      : { traceId: identifier(raw["traceId"], "step.traceId") }),
    ...(llmTokens === undefined ? {} : { llmTokens }),
    ...(governanceTokens === undefined ? {} : { governanceTokens }),
    ...(tokenSources === undefined ? {} : { tokenSources }),
    ...(raw["tokensUnavailableReason"] === undefined
      ? {}
      : { tokensUnavailableReason: "未取得完整用量证据" }),
  };
}
function usageOf(value: unknown): ReportUsage {
  const raw = object(value, "usage");
  if (Object.hasOwn(raw, "total")) invalid("usage.total 已删除，不可跨单位合计");
  const amount = (key: string) =>
    raw[key] === null ? null : number(raw[key], `usage.${key}`, Number.MAX_SAFE_INTEGER);
  return {
    llm: amount("llm"),
    governance: amount("governance"),
    synthetic: amount("synthetic"),
    sources: sourceList(raw["sources"]),
    unavailableSteps: number(raw["unavailableSteps"], "usage.unavailableSteps", MAX_STEPS),
  };
}

export function parseReportJson(value: unknown): ReportJson {
  const raw = object(value, "report");
  if (raw["schemaVersion"] === 1)
    throw new Error(
      "不支持报告 v1：请用当前版本重新运行生成 v2；历史 v1 请用对应旧版本查看，不自动补造快照。",
    );
  if (raw["schemaVersion"] !== 2) invalid("schemaVersion 必须为 2");
  const metadata = metadataOf(raw["metadata"]);
  const initialState = parseSnapshot(metadata.game, raw["initialState"]);
  const finalState = parseSnapshot(metadata.game, raw["finalState"]);
  const steps = list(raw["steps"], "steps", Math.min(metadata.maxSteps, MAX_STEPS)).map(
    (step, index) => stepOf(metadata.game, step, index),
  );
  let hash = snapshotHash(initialState);
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.beforeHash !== hash) invalid("steps 前后状态链不连续");
    if (step.afterHash === null && i !== steps.length - 1) invalid("缺失后态后不能继续记录动作");
    if ((step.outcome === "failed" || step.outcome === "rejected") && i !== steps.length - 1)
      invalid("失败步骤后不能继续记录动作");
    hash = step.afterHash ?? step.beforeHash;
  }
  if (hash !== snapshotHash(finalState)) invalid("finalState 与最后已知状态不一致");
  const findings = list(raw["findings"], "findings", MAX_STEPS * 10).map((finding) =>
    findingOf(metadata.game, finding, steps.length),
  );
  const budget = raw["budget"] === undefined ? undefined : budgetOf(raw["budget"]);
  const stopReason = enumeration(raw["stopReason"], STOP_REASONS, "stopReason");
  const gameTerminal = bool(raw["gameTerminal"], "gameTerminal");
  if (gameTerminal && finalState.status !== "finished")
    invalid("gameTerminal 与 finalState 不一致");
  if (stopReason === "game-finished" && !gameTerminal) invalid("game-finished 必须具备终局证据");
  const errorCategory =
    raw["errorCategory"] === undefined
      ? undefined
      : enumeration(
          raw["errorCategory"],
          ["governance", "game", "strategy", "budget", "state"],
          "errorCategory",
        );
  const status = enumeration(raw["status"], ["passed", "failed", "incomplete"], "status");
  const assertionStatus = enumeration(
    raw["assertionStatus"],
    ["passed", "failed", "not-evaluated"],
    "assertionStatus",
  );
  if (
    !equal(
      { status, assertionStatus },
      deriveReportResult({
        steps,
        findings,
        metadata,
        finalState,
        gameTerminal,
        stopReason,
        errorCategory,
      }),
    )
  )
    invalid("status/assertionStatus 与证据不一致");
  const usage = usageOf(raw["usage"]);
  if (!equal(usage, summarizeUsage(steps, budget))) invalid("usage 与分源账目不一致");
  const stepCount = number(raw["stepCount"], "stepCount", MAX_STEPS);
  const degradedSteps = number(raw["degradedSteps"], "degradedSteps", steps.length);
  const replayedSteps = number(raw["replayedSteps"], "replayedSteps", steps.length);
  const failedSteps = number(raw["failedSteps"], "failedSteps", steps.length);
  if (
    stepCount !== steps.length ||
    degradedSteps !== steps.filter((step) => step.degraded).length ||
    replayedSteps !== steps.filter((step) => step.replayed).length ||
    failedSteps !==
      steps.filter((step) => step.outcome === "failed" || step.outcome === "rejected").length
  )
    invalid("步骤统计不一致");
  const startedAt = number(raw["startedAt"], "startedAt", 8_640_000_000_000_000);
  const finishedAt = number(raw["finishedAt"], "finishedAt", 8_640_000_000_000_000, startedAt);
  if (raw["governanceDegradedReason"] !== undefined)
    text(raw["governanceDegradedReason"], "governanceDegradedReason", 16_384);
  return {
    schemaVersion: 2,
    scenario: text(raw["scenario"], "scenario"),
    session: identifier(raw["session"], "session"),
    businessKey: identifier(raw["businessKey"], "businessKey"),
    seed: number(raw["seed"], "seed", 0xffff_ffff),
    startedAt,
    finishedAt,
    metadata,
    initialState,
    finalState,
    stopReason,
    gameTerminal,
    ...(errorCategory === undefined ? {} : { errorCategory }),
    ...(budget === undefined ? {} : { budget }),
    status,
    assertionStatus,
    stepCount,
    degradedSteps,
    replayedSteps,
    failedSteps,
    governanceSource: identifier(raw["governanceSource"], "governanceSource"),
    ...(raw["governanceDegradedReason"] === undefined
      ? {}
      : { governanceDegradedReason: "治理不可用或证据不完整，已显式降级" }),
    usage,
    findings,
    steps,
  };
}
