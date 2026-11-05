/**
 * 报告 HTML 渲染（纯函数）
 *
 * 用途：本地预览。Qoder 的 Web 预览需要注册 ServiceWorker，在部分环境会报
 * `InvalidStateError`；HTML 报告不依赖 ServiceWorker/JS，浏览器直接打开即可。
 *
 * 约束：自包含、无外部资源、无脚本；所有动态文本必须转义。
 */

import type { ReportJson } from "../core/report-core.js";

export function renderReportHtml(report: ReportJson): string {
  const e = escapeHtml;
  // 兼容 2026-11-05 之前没有 usage 字段的旧报告。
  const usage = report.usage ?? {
    llm: 0,
    governance: 0,
    total: 0,
    sources: [] as string[],
    unavailableSteps: 0,
  };
  const statusClass = `status-${report.status}`;
  const findings =
    report.findings.length === 0
      ? '<p class="muted">无。</p>'
      : `<table>
  <thead><tr><th>编号</th><th>级别</th><th>步骤</th><th>描述</th></tr></thead>
  <tbody>
    ${report.findings
      .map(
        (finding) =>
          `<tr><td><code>${e(finding.code)}</code></td>` +
          `<td class="severity-${e(finding.severity)}">${e(finding.severity)}</td>` +
          `<td>${e(finding.stepNo ?? "-")}</td><td>${e(finding.message)}</td></tr>`,
      )
      .join("\n    ")}
  </tbody>
</table>`;

  const steps = report.steps
    .map((step) => {
      const tokens = [
        step.llmTokens !== undefined ? `llm:${step.llmTokens}` : "",
        step.governanceTokens !== undefined ? `gov:${step.governanceTokens}` : "",
      ]
        .filter(Boolean)
        .join(" / ");
      return (
        `<tr><td>${step.stepNo}</td><td><code>${e(step.actionId ?? "-")}</code></td>` +
        `<td class="outcome-${e(step.outcome)}">${e(step.outcome)}</td>` +
        `<td>${step.replayed ? "是" : "否"}</td><td>${step.degraded ? "是" : "否"}</td>` +
        `<td>${e(tokens || "-")}</td><td><code>${e(step.traceId ?? "-")}</code></td>` +
        `<td><code>${e(step.digest.slice(0, 8))}</code></td><td>${step.elapsedMs}</td></tr>`
      );
    })
    .join("\n    ");

  const degradedReasons = [
    ...new Set(
      report.steps
        .filter((step) => step.degraded && step.degradedReason)
        .map((step) => step.degradedReason!),
    ),
  ];
  const degradedSection =
    degradedReasons.length === 0
      ? ""
      : `<h2>降级说明</h2><ul>${degradedReasons
          .map((reason) => `<li>${e(reason)}</li>`)
          .join("")}</ul>`;

  const traceCoverage = report.steps.filter((step) => step.traceId).length;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Playtest 报告 · ${e(report.scenario)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f6f4ef; color: #1f2328; font: 14px/1.65 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  main { max-width: 1180px; margin: 0 auto; padding: 40px 24px 80px; }
  h1 { font-size: 28px; margin: 0 0 6px; letter-spacing: -0.02em; }
  h2 { font-size: 18px; margin: 34px 0 12px; border-bottom: 2px solid #e5e0d8; padding-bottom: 6px; }
  .meta { color: #6b7280; margin-bottom: 24px; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-weight: 600; font-size: 13px; }
  .status-passed { background: #e7f6ec; color: #166534; }
  .status-failed { background: #fdecec; color: #991b1b; }
  .status-incomplete { background: #fff4e0; color: #9a3412; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e5e0d8; margin: 10px 0 18px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #eee9e0; text-align: left; vertical-align: top; }
  th { background: #faf8f4; font-weight: 600; white-space: nowrap; }
  tr:last-child td { border-bottom: 0; }
  code { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: 12.5px; }
  .muted { color: #6b7280; }
  .severity-fatal, .outcome-failed { color: #b91c1c; font-weight: 600; }
  .severity-warning { color: #b45309; font-weight: 600; }
  .outcome-replayed { color: #1d4ed8; font-weight: 600; }
  .note { background: #fff; border-left: 4px solid #d6d0c4; padding: 10px 14px; margin: 12px 0; }
  ul { margin: 8px 0 0 20px; padding: 0; }
  @media print { body { background: #fff; } main { padding: 0; } table { break-inside: auto; } }
</style>
</head>
<body>
<main>
  <h1>Playtest 报告 · ${e(report.scenario)}</h1>
  <p class="meta">
    <span class="badge ${statusClass}">${e(report.status)}</span>
    · 会话 <code>${e(report.session)}</code>
    · 对局 <code>${e(report.businessKey)}</code>
    · seed <code>${e(report.seed)}</code>
    · ${e(new Date(report.finishedAt).toLocaleString("zh-CN"))}
  </p>

  <table>
    <tbody>
      <tr><th>步数</th><td>${report.stepCount}</td><th>降级步数</th><td>${report.degradedSteps}</td></tr>
      <tr><th>重放步数</th><td>${report.replayedSteps}</td><th>失败步数</th><td>${report.failedSteps}</td></tr>
      <tr><th>治理来源</th><td colspan="3"><code>${e(report.governanceSource)}</code></td></tr>
      ${report.governanceDegradedReason ? `<tr><th>治理降级</th><td colspan="3">${e(report.governanceDegradedReason)}</td></tr>` : ""}
    </tbody>
  </table>

  <h2>治理证据</h2>
  <table>
    <tbody>
      <tr><th>LLM tokens</th><td>${usage.llm}</td><th>治理 tokens</th><td>${usage.governance}</td></tr>
      <tr><th>tokens 合计</th><td>${usage.total}</td><th>来源</th><td>${e(usage.sources.join(", ") || "无")}</td></tr>
      <tr><th>无成本数据步数</th><td>${usage.unavailableSteps}</td><th>traceId 覆盖</th><td>${traceCoverage}/${report.stepCount}</td></tr>
    </tbody>
  </table>
  ${
    usage.sources.includes("synthetic")
      ? '<div class="note">内存替身的 token 数是固定合成值，不代表真实成本。</div>'
      : ""
  }
  ${
    usage.sources.includes("governance-usage")
      ? '<div class="note">治理 tokens 为 aiwarden 工具调用的配额当量，不是模型 token。</div>'
      : ""
  }
  ${
    usage.unavailableSteps > 0
      ? `<div class="note">有 ${usage.unavailableSteps} 步未取得成本数据；报告中未填 0。</div>`
      : ""
  }

  <h2>发现</h2>
  ${findings}

  <h2>步骤</h2>
  <table>
    <thead>
      <tr><th>#</th><th>动作</th><th>结果</th><th>幂等</th><th>降级</th><th>tokens</th><th>trace</th><th>摘要</th><th>耗时(ms)</th></tr>
    </thead>
    <tbody>
    ${steps}
    </tbody>
  </table>

  ${degradedSection}
</main>
</body>
</html>
`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}
