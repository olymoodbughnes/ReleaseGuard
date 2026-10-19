# ReleaseGuard

ReleaseGuard is a TypeScript CLI that compares a **current** (baseline/production) URL with an **update** (candidate) URL before you ship. It measures latency and errors, decides PASS/FAIL with clear reasons, writes a Markdown report, and can run in GitHub Actions so a bad release fails the check.

It also includes an optional **k6** load test against the update URL.

## What it does

1. Sends HTTP requests to both URLs in alternating rounds:
   - 3 rounds
   - each round: 10 sequential requests to **current**, then 10 to **update**
   - 30 requests per URL total
2. Records every request (deployment, round, latency, status, success, timestamp).
3. Computes **average latency**, **p95 latency**, and **error rate** per URL.
4. Compares update vs current and applies thresholds:
   - latency may rise by at most **+15%** (average or p95)
   - update error rate must stay at or below **1%**
5. Classifies the outcome:
   - **PASS** — within limits
   - **FAIL: PERFORMANCE_REGRESSION** — healthy baseline, but update is worse
   - **FAIL: UNHEALTHY_BASELINE** — current itself is too error-prone (not treated as a regression)
6. Prints a console summary and saves `releaseguard-report-<timestamp>.md` (even when it exits with code 1).

## Quick start

```bash
npm install
npm start -- https://current.example.com https://update.example.com
```

Exit code `0` = PASS, `1` = FAIL.

## Tests

Unit tests cover summarization, threshold evaluation, formatting, and report generation:

```bash
npm test
```

## Docker

```bash
docker build -t releaseguard .
docker run --rm releaseguard https://current.example.com https://update.example.com
```

## GitHub Actions

Workflow: `.github/workflows/releaseguard.yml`

Runs on:

- **manual dispatch** — pass `current_url` and `update_url`
- **pull requests to `main`** — reads secrets:
  - `RELEASEGUARD_CURRENT_URL`
  - `RELEASEGUARD_UPDATE_URL`

Jobs:

| Job | Purpose |
| --- | --- |
| `releaseguard` | Benchmark both URLs, post Markdown report to the workflow summary, upload artifact |
| `k6` | Load-test the **update** URL only, post/upload k6 report |
| `test` | Run unit tests |

## k6 load test

Script: `k6/load-test.js`

```bash
k6 run -e BASE_URL=https://update.example.com k6/load-test.js
```

Defaults: 5 VUs for 20s. Fails if failed-request rate ≥ 1% or p95 latency ≥ 1500ms. Writes `k6-report.md` with latency stats, thresholds, and checks (overall PASS only if **both** checks and thresholds pass).

## Project layout

```
src/index.ts          CLI entry (HTTP benchmarking + report save)
src/lib.ts            Core metrics, evaluation, Markdown report
src/lib.test.ts       Automated unit tests
k6/load-test.js       Load test + k6 Markdown report
.github/workflows/    CI (ReleaseGuard + k6 + tests)
Dockerfile            Container image for the CLI
```

## License

MIT
