import http from "k6/http";
import { check, sleep } from "k6";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";

const BASE_URL = __ENV.BASE_URL || "https://www.fokimono.pl";

export const options = {
  vus: 5,
  duration: "20s",
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1500"],
  },
};

export default function () {
  const res = http.get(BASE_URL);

  check(res, {
    "status is 2xx": (r) => r.status >= 200 && r.status < 300,
  });

  sleep(1);
}

function metricValue(data, name, key) {
  const metric = data.metrics[name];
  if (!metric || metric.values[key] === undefined) return "n/a";
  const value = metric.values[key];
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return String(value);
}

function formatMs(data, name, key) {
  const metric = data.metrics[name];
  if (!metric || metric.values[key] === undefined) return "n/a";
  return `${metric.values[key].toFixed(2)}ms`;
}

function formatRate(data, name) {
  const metric = data.metrics[name];
  if (!metric || metric.values.rate === undefined) return "n/a";
  return `${(metric.values.rate * 100).toFixed(2)}%`;
}

function buildMarkdown(data) {
  const thresholdRows = [];
  let thresholdsPassed = true;
  for (const [metricName, metric] of Object.entries(data.metrics || {})) {
    for (const [thresholdExpr, result] of Object.entries(metric.thresholds || {})) {
      if (!result.ok) thresholdsPassed = false;
      thresholdRows.push(
        `| \`${metricName}: ${thresholdExpr}\` | ${result.ok ? "PASS" : "FAIL"} |`,
      );
    }
  }

  const checkRows = [];
  let checksPassed = true;
  function collectChecks(group, prefix = "") {
    for (const checkItem of Object.values(group.checks || {})) {
      if (checkItem.fails > 0) checksPassed = false;
      const total = checkItem.passes + checkItem.fails;
      const rate = total > 0 ? ((checkItem.passes / total) * 100).toFixed(1) : "n/a";
      checkRows.push(
        `| ${prefix}${checkItem.name} | ${checkItem.passes} | ${checkItem.fails} | ${rate}% |`,
      );
    }
    const children = Array.isArray(group.groups)
      ? group.groups
      : Object.values(group.groups || {});
    for (const child of children) {
      collectChecks(child, `${prefix}${child.name} / `);
    }
  }
  if (data.root_group) {
    collectChecks(data.root_group);
  }

  const overallPassed = checksPassed && thresholdsPassed;

  const lines = [
    "# k6 Load Test Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Target",
    "",
    `- **URL:** ${BASE_URL}`,
    `- **VUs:** ${options.vus}`,
    `- **Duration:** ${options.duration}`,
    "",
    "## Summary",
    "",
    `| Metric | Value |`,
    `| --- | --- |`,
    `| HTTP requests | ${metricValue(data, "http_reqs", "count")} |`,
    `| Request rate | ${metricValue(data, "http_reqs", "rate")}/s |`,
    `| Failed requests | ${formatRate(data, "http_req_failed")} |`,
    `| Avg latency | ${formatMs(data, "http_req_duration", "avg")} |`,
    `| Median latency | ${formatMs(data, "http_req_duration", "med")} |`,
    `| p90 latency | ${formatMs(data, "http_req_duration", "p(90)")} |`,
    `| p95 latency | ${formatMs(data, "http_req_duration", "p(95)")} |`,
    `| Max latency | ${formatMs(data, "http_req_duration", "max")} |`,
    `| Data received | ${metricValue(data, "data_received", "count")} bytes |`,
    `| Data sent | ${metricValue(data, "data_sent", "count")} bytes |`,
    `| Iterations | ${metricValue(data, "iterations", "count")} |`,
    `| Checks passed | ${checksPassed ? "yes" : "no"} |`,
    `| Thresholds passed | ${thresholdsPassed ? "yes" : "no"} |`,
    `| Overall result | ${overallPassed ? "PASS" : "FAIL"} |`,
    "",
    "## Thresholds",
    "",
    `| Threshold | Result |`,
    `| --- | --- |`,
    thresholdRows.length > 0 ? thresholdRows.join("\n") : "| _(none)_ | — |",
    "",
    "## Checks",
    "",
    `| Check | Passes | Fails | Pass rate |`,
    `| --- | --- | --- | --- |`,
    checkRows.length > 0 ? checkRows.join("\n") : "| _(none)_ | — | — | — |",
    "",
  ];

  return lines.join("\n");
}

export function handleSummary(data) {
  const markdown = buildMarkdown(data);
  const stamp = new Date().toISOString().replaceAll(":", "-");

  return {
    stdout: textSummary(data, { indent: " ", enableColors: true }),
    [`k6-report-${stamp}.md`]: markdown,
    "k6-report.md": markdown,
  };
}
