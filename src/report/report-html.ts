/** 自包含、无 JS、无外部资源；先验证 v2，再纯渲染与转义。 */
import { parseReportJson } from "../core/recording.js";
import type { Finding, ReportJson } from "../core/report-core.js";
import type { GameKind, PublicSnapshot } from "../types/run.js";

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}
const e = escapeHtml;
const table = (content: string) => `<div class="table-scroll" tabindex="0">${content}</div>`;

function mismatchCells(finding: Finding | undefined): Set<string> {
  const cells = new Set<string>();
  for (const item of finding?.evidence ?? []) {
    const field = item.field.replace(/^payload\./, "");
    const match = /^board(?:\[([0-7])\]\[([0-7])\]|\.([0-7])\.([0-7]))$/.exec(field);
    if (match && item.expected !== item.actual)
      cells.add(`${match[1] ?? match[3]},${match[2] ?? match[4]}`);
    if (field === "board" && Array.isArray(item.expected) && Array.isArray(item.actual)) {
      for (let row = 0; row < 8; row++)
        for (let col = 0; col < 8; col++) {
          if (item.expected[row]?.[col] !== item.actual[row]?.[col]) cells.add(`${row},${col}`);
        }
    }
  }
  return cells;
}
function renderBoard(value: unknown, title: string, mismatches: Set<string>): string {
  const rows = value as readonly (readonly number[])[];
  return `<figure><figcaption>${e(title)}（0 起行列；红框为 Oracle 差异格）</figcaption>${table(`<table class="board" aria-label="${e(title)}"><thead><tr><th></th>${Array.from({ length: 8 }, (_, col) => `<th>${col}</th>`).join("")}</tr></thead><tbody>${rows.map((row, r) => `<tr><th>${r}</th>${row.map((cell, c) => `<td class="${mismatches.has(`${r},${c}`) ? "mismatch" : ""}" aria-label="${r},${c}: ${cell === 1 ? "黑" : cell === 2 ? "白" : "空"}${mismatches.has(`${r},${c}`) ? "，Oracle 差异格" : ""}">${cell ? `<span class="stone ${cell === 1 ? "black" : "white"}"></span>` : "·"}</td>`).join("")}</tr>`).join("")}</tbody></table>`)}</figure>`;
}
function renderSnapshot(
  game: GameKind,
  snapshot: PublicSnapshot,
  title: string,
  mismatches: Set<string>,
): string {
  if (game === "othello") return renderBoard(snapshot.payload["board"], title, mismatches);
  return `<section><h3>${e(title)}</h3><p>FEN</p><pre>${e(snapshot.payload["fen"])}</pre><p>结果：<code>${e(JSON.stringify(snapshot.payload["result"]))}</code> · moveCount ${e(snapshot.payload["moveCount"])}</p><details><summary>走子与 FEN 历史</summary><pre>${e(JSON.stringify({ moves: snapshot.payload["moves"], fenHistory: snapshot.payload["fenHistory"] }, null, 2))}</pre></details></section>`;
}
function renderEvidence(finding: Finding): string {
  if (!finding.evidence?.length)
    return '<p class="muted">没有结构化 Oracle 证据；不补造预期棋盘或修复结论。</p>';
  return table(
    `<table><thead><tr><th>独立 Oracle 字段</th><th>预期</th><th>实际</th></tr></thead><tbody>${finding.evidence.map((item) => `<tr><td><code>${e(item.field)}</code></td><td><pre>${e(JSON.stringify(item.expected))}</pre></td><td><pre>${e(JSON.stringify(item.actual))}</pre></td></tr>`).join("")}</tbody></table>`,
  );
}

export function renderReportHtml(input: ReportJson): string {
  const report = parseReportJson(input);
  const fatal = report.findings
    .filter((finding) => finding.severity === "fatal")
    .sort((a, b) => (a.stepNo ?? -1) - (b.stepNo ?? -1))[0];
  const firstStep =
    fatal?.stepNo === null || fatal?.stepNo === undefined ? undefined : report.steps[fatal.stepNo];
  const mismatches = mismatchCells(fatal);
  const firstFailure = fatal
    ? `<section class="first-failure"><h2>首个违规 · ${e(fatal.code)}</h2><p>${e(fatal.message)} · ${firstStep ? `<a href="#step-${firstStep.stepNo}">步骤 ${firstStep.stepNo}</a> · 动作 <code>${e(firstStep.actionId ?? "无")}</code>` : "初始 / 最终状态检查"}</p>${renderSnapshot(report.metadata.game, firstStep?.before ?? report.initialState, "首错前态 before", mismatches)}${renderEvidence(fatal)}${firstStep?.after ? `<details><summary>查看首错后态 after（实际观察）</summary>${renderSnapshot(report.metadata.game, firstStep.after, "实际后态", mismatches)}</details>` : ""}</section>`
    : `<div class="note">无 fatal 发现。${report.status === "incomplete" ? "本次未完成，不能视为整局通过。" : "仅代表本次记录及已执行断言未发现 fatal。"}</div>`;
  const findings = report.findings.length
    ? table(
        `<table><thead><tr><th>编号</th><th>级别</th><th>步骤</th><th>描述 / 证据</th></tr></thead><tbody>${report.findings.map((finding) => `<tr><td><code>${e(finding.code)}</code></td><td class="severity-${e(finding.severity)}">${e(finding.severity)}</td><td>${finding.stepNo === null ? "状态检查" : `<a href="#step-${finding.stepNo}">${finding.stepNo}</a>`}</td><td>${e(finding.message)}${renderEvidence(finding)}</td></tr>`).join("")}</tbody></table>`,
      )
    : '<p class="muted">无。</p>';
  const steps = report.steps
    .map((step) => {
      const amounts = `llm:${step.llmTokens ?? "unknown"} / ${step.tokenSources?.includes("synthetic") ? "synthetic" : "gov"}:${step.governanceTokens ?? "unknown"}`;
      return `<tr id="step-${step.stepNo}"><td><a href="#step-${step.stepNo}">${step.stepNo}</a></td><td><code>${e(step.actionId ?? "无动作")}</code><details><summary>动作与公开状态</summary><pre>${e(JSON.stringify(step.action, null, 2))}</pre>${renderSnapshot(report.metadata.game, step.before, "before", new Set())}${step.after ? renderSnapshot(report.metadata.game, step.after, "after", new Set()) : "<p>后态 unknown；没有伪造执行结果。</p>"}</details></td><td class="outcome-${step.outcome}">${step.outcome}${step.error ? `<p>${e(step.error)}</p>` : ""}</td><td>${step.replayed ? "是" : "否"}</td><td>${step.degraded ? `是 · ${e(step.degradedReason)}` : "否"}</td><td>${e(amounts)}</td><td><code>${e(step.traceId ?? "无")}</code></td><td><code title="${e(step.beforeHash)}">${e(step.beforeHash.slice(0, 12))}</code> → <code title="${e(step.afterHash ?? "unknown")}">${e(step.afterHash?.slice(0, 12) ?? "unknown")}</code></td><td>${step.elapsedMs}</td></tr>`;
    })
    .join("");
  const budget = report.budget;
  const knownTokens =
    budget?.attempts.reduce((sum, attempt) => sum + (attempt.tokens ?? 0), 0) ?? 0;
  const budgetSection = budget
    ? `<h2>模型预算与尝试</h2><p>已预扣调用 ${budget.attempts.length} / ${budget.maxCalls}；token 软停止线 ${budget.tokenLimit ?? "未设置"}；已知 tokens ${knownTokens}；已知越过量 ${budget.tokenLimit === undefined ? "不适用" : Math.max(0, knownTokens - budget.tokenLimit)}。未知尝试不退款、不按 0 结算。</p>${table(`<table><thead><tr><th>callId</th><th>状态</th><th>模型 tokens</th></tr></thead><tbody>${budget.attempts.map((attempt) => `<tr><td>${attempt.callId}</td><td>${attempt.state}</td><td>${attempt.tokens ?? "unknown"}</td></tr>`).join("")}</tbody></table>`)}`
    : "";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Playtest 报告 · ${e(report.scenario)}</title><style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f6f4ef;color:#1f2328;font:14px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}main{max-width:1180px;margin:auto;padding:32px 24px 70px}h1{font-size:28px;margin:0}h2{font-size:20px;border-bottom:2px solid #e5e0d8;margin-top:30px}h3{font-size:16px}.meta,.muted{color:#59616d}.badge{display:inline-block;padding:3px 12px;border-radius:20px;font-weight:700}.status-passed{background:#e7f6ec;color:#166534}.status-failed{background:#fdecec;color:#991b1b}.status-incomplete{background:#fff4e0;color:#9a3412}.table-scroll{max-width:100%;overflow-x:auto;overscroll-behavior-x:contain}table{width:100%;border-collapse:collapse;background:white;margin:10px 0 18px}th,td{padding:8px 10px;border:1px solid #e5e0d8;text-align:left;vertical-align:top}th{background:#faf8f4;white-space:nowrap}.steps{min-width:900px}code,pre{font:12px/1.6 ui-monospace,Consolas,monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:48rem}p,td{overflow-wrap:anywhere}.severity-fatal,.outcome-failed,.outcome-rejected{color:#b91c1c;font-weight:600}.severity-warning{color:#945700}.note{background:#fff;border-left:4px solid #b0a898;padding:12px;margin:16px 0}a{color:#135fab}details{margin:8px 0}summary{cursor:pointer}figure{margin:12px 0}.board{width:100%;max-width:360px;table-layout:fixed}.board th,.board td{height:36px;text-align:center;padding:2px;vertical-align:middle}.board td{background:#bcd7c5;color:#536b5a}.board .mismatch{outline:3px solid #bc2525;outline-offset:-3px}.stone{display:inline-block;width:24px;height:24px;border-radius:50%;vertical-align:middle}.black{background:#202328;border:1px solid #000}.white{background:#fff;border:1px solid #667368}:target{outline:2px solid #135fab}figcaption{color:#59616d}.first-failure{border-left:3px solid #bc2525;padding-left:16px}@media(max-width:600px){main{padding:20px 12px}h1{font-size:23px}.first-failure{padding-left:8px}}@media print{body{background:#fff}main{padding:0}.table-scroll{overflow:visible}}
</style></head><body><main>
<h1>Playtest 报告 · ${e(report.scenario)}</h1>
<p class="meta"><span class="badge status-${report.status}">${report.status}</span> · 断言 ${report.assertionStatus} · 停止原因 <strong>${report.stopReason}</strong> · 游戏终局 ${report.gameTerminal ? "是" : "否"}</p>
<p>证据来源 <strong>${report.metadata.source}</strong> · ${report.metadata.game} · 目标版本 <code>${e(report.metadata.targetVersion)}</code> · 错误类别 ${report.errorCategory ?? "无"}</p>
${firstFailure}
<h2>运行条件</h2>${table(`<table><tbody><tr><th>会话 / 对局</th><td>${e(report.session)} / ${e(report.businessKey)}</td></tr><tr><th>seed / 步数 / 上限</th><td>${report.seed} / ${report.stepCount} / ${report.metadata.maxSteps}</td></tr><tr><th>Agent / 适配器 / Oracle</th><td>${e(report.metadata.agentVersion)} / ${e(report.metadata.adapter)} / ${e(report.metadata.oracle)}</td></tr><tr><th>策略 / prompt / 目标</th><td>${e(report.metadata.strategy)} / ${e(report.metadata.promptVersion ?? "未设置")} / ${e(report.metadata.target ?? "未设置")}</td></tr><tr><th>降级 / 重放 / 失败步数</th><td>${report.degradedSteps} / ${report.replayedSteps} / ${report.failedSteps}</td></tr><tr><th>起止时间（UTC）</th><td>${e(new Date(report.startedAt).toISOString())} → ${e(new Date(report.finishedAt).toISOString())}</td></tr></tbody></table>`)}
<h2>治理证据</h2>${table(`<table><tbody><tr><th>LLM tokens</th><td>${report.usage.llm ?? "unknown"}</td></tr><tr><th>治理配额当量</th><td>${report.usage.governance ?? "unknown"}</td></tr><tr><th>替身合成值</th><td>${report.usage.synthetic ?? "unknown"}</td></tr><tr><th>来源</th><td>${e(report.usage.sources.join(", ") || "无")} · ${e(report.governanceSource)}</td></tr><tr><th>无成本数据步数 / traceId 覆盖</th><td>${report.usage.unavailableSteps} / ${report.steps.filter((step) => step.traceId).length}</td></tr></tbody></table>`)}
<p class="note">三种单位分列，不相加。治理配额当量不是模型 tokens；替身合成值不代表真实成本。unknown 不是 0；缺失任一相关用量时不以已知部分冒充完整用量。</p>
${report.governanceDegradedReason ? `<p class="note">治理降级：${e(report.governanceDegradedReason)}</p>` : ""}${budgetSection}
<h2>发现</h2>${findings}
<h2>步骤</h2>${table(`<table class="steps"><thead><tr><th>#</th><th>动作</th><th>结果</th><th>幂等</th><th>降级</th><th>分源用量</th><th>trace</th><th>公开状态摘要</th><th>耗时(ms)</th></tr></thead><tbody>${steps}</tbody></table>`)}
<details><summary>初态与末态</summary>${renderSnapshot(report.metadata.game, report.initialState, "初始公开状态", new Set())}${renderSnapshot(report.metadata.game, report.finalState, "最终公开状态", new Set())}</details>
</main></body></html>\n`;
}
