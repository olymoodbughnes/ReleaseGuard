import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type BenchmarkResult,
  type Measurement,
  MAX_ERROR_RATE_PERCENT,
  MAX_LATENCY_INCREASE_PERCENT,
  evaluate,
  formatMs,
  formatPercentChange,
  formatPpDiff,
  generateReport,
  latencyChangePercent,
  summarize,
} from "./lib.ts";

function measurement(
  overrides: Partial<Measurement> & Pick<Measurement, "deployment" | "responseTimeMs" | "success">,
): Measurement {
  return {
    round: 1,
    request: 1,
    status: overrides.success ? 200 : 500,
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function result(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    avg: 100,
    p95: 120,
    errorRate: 0,
    errors: 0,
    serverErrors: 0,
    totalRequests: 30,
    ...overrides,
  };
}

describe("summarize", () => {
  it("computes avg, p95, and error rate for a deployment", () => {
    const measurements: Measurement[] = [
      measurement({ deployment: "current", request: 1, responseTimeMs: 100, success: true }),
      measurement({ deployment: "current", request: 2, responseTimeMs: 200, success: true }),
      measurement({
        deployment: "current",
        request: 3,
        responseTimeMs: 50,
        success: false,
        status: 500,
      }),
      measurement({ deployment: "update", request: 1, responseTimeMs: 999, success: true }),
    ];

    const current = summarize(measurements, "current");

    assert.equal(current.totalRequests, 3);
    assert.equal(current.errors, 1);
    assert.equal(current.serverErrors, 1);
    assert.equal(current.errorRate, (1 / 3) * 100);
    assert.equal(current.avg, 150);
    assert.equal(current.p95, 200);
  });

  it("returns null latency metrics when there are no successful requests", () => {
    const measurements: Measurement[] = [
      measurement({
        deployment: "update",
        responseTimeMs: 10,
        success: false,
        status: null,
        error: "timeout",
      }),
    ];

    const update = summarize(measurements, "update");

    assert.equal(update.avg, null);
    assert.equal(update.p95, null);
    assert.equal(update.errorRate, 100);
  });

  it("returns zeros when a deployment has no measurements", () => {
    const empty = summarize([], "current");

    assert.deepEqual(empty, {
      avg: null,
      p95: null,
      errorRate: 0,
      errors: 0,
      serverErrors: 0,
      totalRequests: 0,
    });
  });
});

describe("latencyChangePercent", () => {
  it("computes percentage change", () => {
    assert.equal(latencyChangePercent(100, 115), 15);
    assert.equal(latencyChangePercent(100, 85), -15);
  });

  it("returns null for missing or zero baselines", () => {
    assert.equal(latencyChangePercent(null, 100), null);
    assert.equal(latencyChangePercent(100, null), null);
    assert.equal(latencyChangePercent(0, 50), null);
  });
});

describe("format helpers", () => {
  it("formats milliseconds and percentage changes", () => {
    assert.equal(formatMs(42), "42ms");
    assert.equal(formatMs(null), "n/a");
    assert.equal(formatPercentChange(15.24), "+15.2%");
    assert.equal(formatPercentChange(-3.1), "-3.1%");
    assert.equal(formatPercentChange(null), "n/a");
    assert.equal(formatPpDiff(2.5), "+2.5 pp");
    assert.equal(formatPpDiff(-1), "-1 pp");
  });
});

describe("evaluate", () => {
  it("passes when latency and error rate stay within limits", () => {
    const verdict = evaluate(
      result({ avg: 100, p95: 120, errorRate: 0 }),
      result({ avg: 110, p95: 130, errorRate: 0 }),
    );

    assert.equal(verdict.kind, "PASS");
    assert.equal(verdict.passed, true);
    assert.deepEqual(verdict.failures, []);
  });

  it("fails as PERFORMANCE_REGRESSION when average latency rises too much", () => {
    const verdict = evaluate(
      result({ avg: 100, p95: 100 }),
      result({ avg: 100 + MAX_LATENCY_INCREASE_PERCENT + 1, p95: 100 }),
    );

    assert.equal(verdict.kind, "PERFORMANCE_REGRESSION");
    assert.equal(verdict.passed, false);
    assert.ok(verdict.failures.some((f) => f.includes("Average latency")));
  });

  it("fails as PERFORMANCE_REGRESSION when p95 latency rises too much", () => {
    const verdict = evaluate(
      result({ avg: 100, p95: 100 }),
      result({ avg: 100, p95: 100 + MAX_LATENCY_INCREASE_PERCENT + 1 }),
    );

    assert.equal(verdict.kind, "PERFORMANCE_REGRESSION");
    assert.ok(verdict.failures.some((f) => f.includes("p95 latency")));
  });

  it("fails as PERFORMANCE_REGRESSION when update error rate exceeds the limit", () => {
    const verdict = evaluate(
      result({ errorRate: 0 }),
      result({ errorRate: MAX_ERROR_RATE_PERCENT + 1, serverErrors: 2 }),
    );

    assert.equal(verdict.kind, "PERFORMANCE_REGRESSION");
    assert.ok(verdict.failures.some((f) => f.includes("Update error rate")));
    assert.ok(verdict.failures.some((f) => f.includes("HTTP 5xx")));
  });

  it("fails as UNHEALTHY_BASELINE when current error rate is too high", () => {
    const verdict = evaluate(
      result({ errorRate: MAX_ERROR_RATE_PERCENT + 5, serverErrors: 3, totalRequests: 30 }),
      result({ avg: 500, p95: 800, errorRate: 0 }),
    );

    assert.equal(verdict.kind, "UNHEALTHY_BASELINE");
    assert.equal(verdict.passed, false);
    assert.ok(verdict.failures.some((f) => f.includes("baseline")));
    assert.ok(verdict.failures.some((f) => f.includes("Latency comparison skipped")));
  });

  it("does not treat a bad baseline as a performance regression", () => {
    const verdict = evaluate(
      result({ errorRate: 50, serverErrors: 15 }),
      result({ avg: 1000, p95: 2000, errorRate: 0 }),
    );

    assert.equal(verdict.kind, "UNHEALTHY_BASELINE");
    assert.notEqual(verdict.kind, "PERFORMANCE_REGRESSION");
  });
});

describe("generateReport", () => {
  it("includes comparison, thresholds, verdict, and request breakdown", () => {
    const current = result({ avg: 100, p95: 120, errorRate: 0, totalRequests: 1 });
    const update = result({ avg: 110, p95: 130, errorRate: 0, totalRequests: 1 });
    const verdict = evaluate(current, update);
    const measurements: Measurement[] = [
      measurement({
        deployment: "current",
        round: 1,
        request: 1,
        responseTimeMs: 100,
        success: true,
        status: 200,
      }),
      measurement({
        deployment: "update",
        round: 1,
        request: 1,
        responseTimeMs: 110,
        success: true,
        status: 200,
      }),
    ];

    const report = generateReport(
      current,
      update,
      "https://current.example",
      "https://update.example",
      verdict,
      measurements,
    );

    assert.match(report, /# ReleaseGuard Report/);
    assert.match(report, /https:\/\/current\.example/);
    assert.match(report, /https:\/\/update\.example/);
    assert.match(report, /Latency limit/);
    assert.match(report, /Error-rate limit/);
    assert.match(report, /Average latency/);
    assert.match(report, /\*\*PASS\*\*/);
    assert.match(report, /## Request breakdown/);
    assert.match(report, /### current/);
    assert.match(report, /### update/);
    assert.match(report, /\| 1 \| 100ms \| 200 \| yes \|/);
  });

  it("labels unhealthy baseline failures clearly", () => {
    const current = result({ errorRate: 20, serverErrors: 6 });
    const update = result();
    const verdict = evaluate(current, update);
    const report = generateReport(
      current,
      update,
      "https://current.example",
      "https://update.example",
      verdict,
      [],
    );

    assert.match(report, /FAIL: UNHEALTHY_BASELINE/);
    assert.match(report, /Production baseline is unhealthy/);
  });
});
