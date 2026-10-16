const REQUEST_COUNT = 10;
const RUNS_PER_URL = 3;
/** Max allowed latency increase (avg or p95). 15% is a solid default for a small ecommerce shop. */
const MAX_LATENCY_INCREASE_PERCENT = 15;
/** Max allowed absolute error rate on the update (and for treating the baseline as healthy). */
const MAX_ERROR_RATE_PERCENT = 1;

type BenchmarkRun = {
  latencies: number[];
  errors: number;
  serverErrors: number;
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

async function benchmark(url: string, label: string): Promise<BenchmarkRun> {
  console.log(`--- ${label}: ${url} ---\n`);

  const latencies: number[] = [];
  let errors = 0;
  let serverErrors = 0;

  for (let i = 1; i <= REQUEST_COUNT; i++) {
    try {
      const start = performance.now();
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const elapsedMs = Math.round(performance.now() - start);

      if (response.status < 200 || response.status > 299) {
        errors++;
        if (response.status >= 500 && response.status <= 599) {
          serverErrors++;
        }
        console.error(`Request ${i}/${REQUEST_COUNT} failed with HTTP ${response.status}\n`);
        continue;
      }

      latencies.push(elapsedMs);
      console.log(`Request ${i}/${REQUEST_COUNT} — HTTP ${response.status}\nTime: ${elapsedMs}ms\n`);
    } catch (error) {
      errors++;
      if (error instanceof DOMException && error.name === "TimeoutError") {
        console.error(`Request ${i}/${REQUEST_COUNT} to ${url} timed out after 10s\n`);
      } else if (error instanceof Error) {
        console.error(`Request ${i}/${REQUEST_COUNT} failed: ${error.message}\n`);
      } else {
        console.error(`Request ${i}/${REQUEST_COUNT} failed with an unknown error\n`);
      }
    }
  }

  return { latencies, errors, serverErrors };
}

function aggregateRuns(runs: BenchmarkRun[]): BenchmarkResult {
  const latencies = runs.flatMap((run) => run.latencies);
  const errors = runs.reduce((sum, run) => sum + run.errors, 0);
  const serverErrors = runs.reduce((sum, run) => sum + run.serverErrors, 0);
  const totalRequests = runs.length * REQUEST_COUNT;
  const errorRate = (errors / totalRequests) * 100;
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

const currentRuns: BenchmarkRun[] = [];
const updateRuns: BenchmarkRun[] = [];

for (let round = 1; round <= RUNS_PER_URL; round++) {
  currentRuns.push(
    await benchmark(currentUrl, `current (run ${round}/${RUNS_PER_URL})`),
  );
  updateRuns.push(
    await benchmark(updateUrl, `update (run ${round}/${RUNS_PER_URL})`),
  );
}

const current = aggregateRuns(currentRuns);
const update = aggregateRuns(updateRuns);
const verdict = evaluate(current, update);

printComparisonReport(current, update, currentUrl, updateUrl, verdict);

if (!verdict.passed) {
  process.exit(1);
}
