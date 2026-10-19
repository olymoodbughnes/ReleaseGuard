import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  REQUEST_COUNT,
  RUNS_PER_URL,
  MAX_LATENCY_INCREASE_PERCENT,
  MAX_ERROR_RATE_PERCENT,
  type Deployment,
  type Measurement,
  summarize,
  evaluate,
  generateReport,
  formatMs,
  latencyChangePercent,
  formatPercentChange,
  errorRatePpDiff,
  formatPpDiff,
} from "./lib.ts";

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

function saveReport(markdown: string): string {
  const filename = `releaseguard-report-${new Date().toISOString().replaceAll(":", "-")}.md`;
  const filepath = join(process.cwd(), filename);
  writeFileSync(filepath, markdown, "utf8");
  return filepath;
}

function printComparisonReport(
  current: ReturnType<typeof summarize>,
  update: ReturnType<typeof summarize>,
  currentUrl: string,
  updateUrl: string,
  verdict: ReturnType<typeof evaluate>,
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
  console.log(
    `Request pattern: ${RUNS_PER_URL} rounds — each round sends ${REQUEST_COUNT} sequential requests to current, then ${REQUEST_COUNT} to update`,
  );
  console.log(`Total requests per URL: ${current.totalRequests}`);
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

const currentUrl = process.argv[2];
const updateUrl = process.argv[3];

if (!currentUrl || !updateUrl) {
  console.error("Usage: npm start -- <current-url> <update-url>");
  process.exit(1);
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
