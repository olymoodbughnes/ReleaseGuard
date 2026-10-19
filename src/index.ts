import { writeFileSync } from "node:fs";
import { join } from "node:path";

const REQUEST_COUNT = 10;
const RUNS_PER_URL = 3;
/** Max allowed latency increase (avg or p95). 15% is a solid default for a small ecommerce shop. */
const MAX_LATENCY_INCREASE_PERCENT = 15;
/** Max allowed absolute error rate on the update (and for treating the baseline as healthy). */
const MAX_ERROR_RATE_PERCENT = 1;

type Deployment = "current" | "update";

type Measurement = {
  deployment: Deployment;
  round: number;
  request: number;
  responseTimeMs: number;
  status: number | null;
  success: boolean;
  timestamp: string;
  error?: string;
};

type BenchmarkResult = {
  avg: number | null;
  p95: number | null;
  errorRate: number;
  errors: number;
  serverErrors: number;
  totalRequests: number;
};

type VerdictKind = "PASS" | "UNHEALTHY_BASELINE" | "PERFORMANCE_REGRESSION";

type Verdict = {
  passed: boolean;
  kind: VerdictKind;
  failures: string[];
};

async function benchmark(
  url: string,
  deployment: Deployment,
  round: number,
  measurements: Measurement[],
): Promise<void> {
  console.log(`--- ${deployment} (run ${round}/${RUNS_PER_URL}): ${url} ---\n`);

  for (let request = 1; request <= REQUEST_COUNT; request++) {
    const start = performance.now();

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const responseTimeMs = Math.round(performance.now() - start);
      const success = response.status >= 200 && response.status <= 299;

      measurements.push({
        deployment,
        round,
        request,
        responseTimeMs,
        status: response.status,
        success,
        timestamp: new Date().toISOString(),
      });

      if (!success) {
        console.error(`Request ${request}/${REQUEST_COUNT} failed with HTTP ${response.status}\n`);
        continue;
      }

      console.log(
        `Request ${request}/${REQUEST_COUNT} — HTTP ${response.status}\nTime: ${responseTimeMs}ms\n`,
      );
    } catch (error) {
      const responseTimeMs = Math.round(performance.now() - start);
      const message =
        error instanceof DOMException && error.name === "TimeoutError"
          ? `Request to ${url} timed out after 10s`
          : error instanceof Error
            ? error.message
            : "Unknown error";

      measurements.push({
        deployment,
        round,
        request,
        responseTimeMs,
        status: null,
        success: false,
        timestamp: new Date().toISOString(),
        error: message,
      });

      console.error(`Request ${request}/${REQUEST_COUNT} failed: ${message}\n`);
    }
  }
}

function summarize(measurements: Measurement[], deployment: Deployment): BenchmarkResult {
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

const currentUrl = process.argv[2];
const updateUrl = process.argv[3];

if (!currentUrl || !updateUrl) {
  console.error("Usage: npm start -- <current-url> <update-url>");
  process.exit(1);
}

function formatMs(value: number | null): string {
  return value !== null ? `${value}ms` : "n/a";
}

function latencyChangePercent(from: number | null, to: number | null): number | null {
  if (from === null || to === null || from === 0) return null;
  return ((to - from) / from) * 100;
}

function formatPercentChange(change: number | null): string {
  if (change === null) return "n/a";
  const rounded = Math.round(change * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

function errorRatePpDiff(from: number, to: number): number {
  return to - from;
}

function formatPpDiff(diff: number): string {
  const rounded = Math.round(diff * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded} pp`;
}

function evaluate(
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

function generateReport(
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
    `- **Runs per URL:** ${RUNS_PER_URL} (alternating)`,
    `- **Requests per URL:** ${current.totalRequests}`,
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

function saveReport(markdown: string): string {
  const filename = `releaseguard-report-${new Date().toISOString().replaceAll(":", "-")}.md`;
  const filepath = join(process.cwd(), filename);
  writeFileSync(filepath, markdown, "utf8");
  return filepath;
}

function printComparisonReport(
  current: BenchmarkResult,
  update: BenchmarkResult,
  currentUrl: string,
  updateUrl: string,
  verdict: Verdict,
): void {
  const avgChange = latencyChangePercent(current.avg, update.avg);
  const p95Change = latencyChangePercent(current.p95, update.p95);
  const errorDiff = errorRatePpDiff(current.errorRate, update.errorRate);

  const rows = [
    ["Metric", "Current", "Update", "Change"],
    [
      "Average latency",
      formatMs(current.avg),
      formatMs(update.avg),
      formatPercentChange(avgChange),
    ],
    [
      "p95 latency",
      formatMs(current.p95),
      formatMs(update.p95),
      formatPercentChange(p95Change),
    ],
    [
      "Error rate",
      `${current.errorRate}%`,
      `${update.errorRate}%`,
      formatPpDiff(errorDiff),
    ],
    [
      "HTTP 5xx",
      `${current.serverErrors}/${current.totalRequests}`,
      `${update.serverErrors}/${update.totalRequests}`,
      "—",
    ],
  ];

  const widths = rows[0]!.map((_, col) =>
    Math.max(...rows.map((row) => row[col]!.length)),
  );

  const formatRow = (row: string[]) =>
    row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ");

  console.log("=== Comparison Report ===");
  console.log(`Current: ${currentUrl}`);
  console.log(`Update:  ${updateUrl}`);
  console.log(`Runs per URL: ${RUNS_PER_URL} (alternating)`);
  console.log(`Requests per URL: ${current.totalRequests}`);
  console.log(`Latency limit: +${MAX_LATENCY_INCREASE_PERCENT}%`);
  console.log(`Error-rate limit: ${MAX_ERROR_RATE_PERCENT}%\n`);
  console.log(formatRow(rows[0]!));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows.slice(1)) {
    console.log(formatRow(row));
  }
  console.log("");

  if (verdict.kind === "PASS") {
    console.log("PASS");
  } else if (verdict.kind === "UNHEALTHY_BASELINE") {
    console.log("FAIL: UNHEALTHY_BASELINE");
    console.log("Production baseline is unhealthy — not classified as a performance regression.");
  } else {
    console.log("FAIL: PERFORMANCE_REGRESSION");
  }

  for (const failure of verdict.failures) {
    console.log(`  - ${failure}`);
  }
  console.log("");
}

const measurements: Measurement[] = [];

for (let round = 1; round <= RUNS_PER_URL; round++) {
  await benchmark(currentUrl, "current", round, measurements);
  await benchmark(updateUrl, "update", round, measurements);
}

const current = summarize(measurements, "current");
const update = summarize(measurements, "update");
const verdict = evaluate(current, update);

printComparisonReport(current, update, currentUrl, updateUrl, verdict);

const markdown = generateReport(
  current,
  update,
  currentUrl,
  updateUrl,
  verdict,
  measurements,
);
const reportPath = saveReport(markdown);
console.log(`Report saved to ${reportPath}`);

if (!verdict.passed) {
  process.exit(1);
}
