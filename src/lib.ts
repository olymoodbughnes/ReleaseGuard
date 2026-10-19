export const REQUEST_COUNT = 10;
export const RUNS_PER_URL = 3;
/** Max allowed latency increase (avg or p95). 15% is a solid default for a small ecommerce shop. */
export const MAX_LATENCY_INCREASE_PERCENT = 15;
/** Max allowed absolute error rate on the update (and for treating the baseline as healthy). */
export const MAX_ERROR_RATE_PERCENT = 1;

export type Deployment = "current" | "update";

export type Measurement = {
  deployment: Deployment;
  round: number;
  request: number;
  responseTimeMs: number;
  status: number | null;
  success: boolean;
  timestamp: string;
  error?: string;
};

export type BenchmarkResult = {
  avg: number | null;
  p95: number | null;
  errorRate: number;
  errors: number;
  serverErrors: number;
  totalRequests: number;
};

export type VerdictKind = "PASS" | "UNHEALTHY_BASELINE" | "PERFORMANCE_REGRESSION";

export type Verdict = {
  passed: boolean;
  kind: VerdictKind;
  failures: string[];
};

export function summarize(
  measurements: Measurement[],
  deployment: Deployment,
): BenchmarkResult {
  const forDeployment = measurements.filter((m) => m.deployment === deployment);
  const latencies = forDeployment.filter((m) => m.success).map((m) => m.responseTimeMs);
  const errors = forDeployment.filter((m) => !m.success).length;
  const serverErrors = forDeployment.filter(
    (m) => m.status !== null && m.status >= 500 && m.status <= 599,
  ).length;
  const totalRequests = forDeployment.length;
  const errorRate = totalRequests > 0 ? (errors / totalRequests) * 100 : 0;
  const avg =
    latencies.length > 0
      ? Math.round(latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length)
      : null;
  const p95 =
    latencies.length > 0
      ? [...latencies].sort((a, b) => a - b)[Math.ceil(0.95 * latencies.length) - 1]!
      : null;

  return { avg, p95, errorRate, errors, serverErrors, totalRequests };
}

export function formatMs(value: number | null): string {
  return value !== null ? `${value}ms` : "n/a";
}

export function latencyChangePercent(
  from: number | null,
  to: number | null,
): number | null {
  if (from === null || to === null || from === 0) return null;
  return ((to - from) / from) * 100;
}

export function formatPercentChange(change: number | null): string {
  if (change === null) return "n/a";
  const rounded = Math.round(change * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

export function errorRatePpDiff(from: number, to: number): number {
  return to - from;
}

export function formatPpDiff(diff: number): string {
  const rounded = Math.round(diff * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded} pp`;
}

export function evaluate(
  current: BenchmarkResult,
  update: BenchmarkResult,
): Verdict {
  // Baseline itself is too error-prone — don't call that a regression.
  if (current.errorRate > MAX_ERROR_RATE_PERCENT) {
    const failures = [
      `Current (production baseline) error rate is ${current.errorRate}% (limit ${MAX_ERROR_RATE_PERCENT}%)`,
    ];
    if (current.serverErrors > 0) {
      failures.push(
        `Current returned HTTP 5xx on ${current.serverErrors}/${current.totalRequests} requests`,
      );
    }
    failures.push(
      "Latency comparison skipped — baseline is unhealthy, so results are not a reliable regression signal",
    );
    if (update.errorRate > MAX_ERROR_RATE_PERCENT) {
      failures.push(
        `Update error rate is also ${update.errorRate}% (limit ${MAX_ERROR_RATE_PERCENT}%)`,
      );
    }
    return { passed: false, kind: "UNHEALTHY_BASELINE", failures };
  }

  const failures: string[] = [];

  const avgChange = latencyChangePercent(current.avg, update.avg);
  if (avgChange !== null && avgChange > MAX_LATENCY_INCREASE_PERCENT) {
    failures.push(
      `Average latency rose ${formatPercentChange(avgChange)} (limit +${MAX_LATENCY_INCREASE_PERCENT}%)`,
    );
  }

  const p95Change = latencyChangePercent(current.p95, update.p95);
  if (p95Change !== null && p95Change > MAX_LATENCY_INCREASE_PERCENT) {
    failures.push(
      `p95 latency rose ${formatPercentChange(p95Change)} (limit +${MAX_LATENCY_INCREASE_PERCENT}%)`,
    );
  }

  if (update.errorRate > MAX_ERROR_RATE_PERCENT) {
    failures.push(
      `Update error rate is ${update.errorRate}% (limit ${MAX_ERROR_RATE_PERCENT}%)`,
    );
    if (update.serverErrors > 0) {
      failures.push(
        `Update returned HTTP 5xx on ${update.serverErrors}/${update.totalRequests} requests`,
      );
    }
  }

  if (failures.length === 0) {
    return { passed: true, kind: "PASS", failures: [] };
  }

  return { passed: false, kind: "PERFORMANCE_REGRESSION", failures };
}

export function generateReport(
  current: BenchmarkResult,
  update: BenchmarkResult,
  currentUrl: string,
  updateUrl: string,
  verdict: Verdict,
  measurements: Measurement[],
): string {
  const avgChange = latencyChangePercent(current.avg, update.avg);
  const p95Change = latencyChangePercent(current.p95, update.p95);
  const errorDiff = errorRatePpDiff(current.errorRate, update.errorRate);

  const verdictLabel =
    verdict.kind === "PASS"
      ? "PASS"
      : verdict.kind === "UNHEALTHY_BASELINE"
        ? "FAIL: UNHEALTHY_BASELINE"
        : "FAIL: PERFORMANCE_REGRESSION";

  const lines: string[] = [
    "# ReleaseGuard Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Targets",
    "",
    `- **Current:** ${currentUrl}`,
    `- **Update:** ${updateUrl}`,
    `- **Request pattern:** ${RUNS_PER_URL} rounds — each round sends ${REQUEST_COUNT} sequential requests to **current**, then ${REQUEST_COUNT} to **update**`,
    `- **Total requests per URL:** ${current.totalRequests}`,
    "",
    "## Thresholds",
    "",
    `- **Latency limit:** +${MAX_LATENCY_INCREASE_PERCENT}%`,
    `- **Error-rate limit:** ${MAX_ERROR_RATE_PERCENT}%`,
    "",
    "## Comparison",
    "",
    "| Metric | Current | Update | Change |",
    "| --- | --- | --- | --- |",
    `| Average latency | ${formatMs(current.avg)} | ${formatMs(update.avg)} | ${formatPercentChange(avgChange)} |`,
    `| p95 latency | ${formatMs(current.p95)} | ${formatMs(update.p95)} | ${formatPercentChange(p95Change)} |`,
    `| Error rate | ${current.errorRate}% | ${update.errorRate}% | ${formatPpDiff(errorDiff)} |`,
    `| HTTP 5xx | ${current.serverErrors}/${current.totalRequests} | ${update.serverErrors}/${update.totalRequests} | — |`,
    "",
    "## Verdict",
    "",
    `**${verdictLabel}**`,
    "",
  ];

  if (verdict.kind === "UNHEALTHY_BASELINE") {
    lines.push(
      "Production baseline is unhealthy — not classified as a performance regression.",
      "",
    );
  }

  if (verdict.failures.length > 0) {
    lines.push("### Reasons", "");
    for (const reason of verdict.failures) {
      lines.push(`- ${reason}`);
    }
    lines.push("");
  }

  lines.push("## Request breakdown", "");

  for (const deployment of ["current", "update"] as const) {
    lines.push(`### ${deployment}`, "");

    for (let round = 1; round <= RUNS_PER_URL; round++) {
      const roundMeasurements = measurements.filter(
        (m) => m.deployment === deployment && m.round === round,
      );

      lines.push(`#### Round ${round}`, "");
      lines.push("| Request | Latency | HTTP status | Success | Timestamp |");
      lines.push("| --- | --- | --- | --- | --- |");

      for (const m of roundMeasurements) {
        const status = m.status === null ? "n/a" : String(m.status);
        const success = m.success ? "yes" : "no";
        const latency = `${m.responseTimeMs}ms`;
        const note = m.error ? ` (${m.error})` : "";
        lines.push(
          `| ${m.request} | ${latency} | ${status}${note} | ${success} | ${m.timestamp} |`,
        );
      }

      lines.push("");
    }
  }

  return lines.join("\n");
}
