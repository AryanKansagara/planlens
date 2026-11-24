# PlanLens

Spark / Databricks plan analyzer for explain() output.

## Develop

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Test

```bash
npm test          # parser, analysis and diff unit tests (node:test)
npm run build     # type-check and production build into dist/
npm run test:e2e  # builds, then runs the Playwright (Chromium) suite against `vite preview`
```

The E2E suite lives in `e2e/` and drives the production build: every sample, plans pasted from the Spark docs and Spark's
own TPC-DS q3 output, adaptive plans, A/B compare, rejected and empty input, and what persists across a reload. Install the
browser once with `npx playwright install chromium` (add `--with-deps` on a fresh Linux machine). The tests use only
synthetic samples and Apache Spark's published plans, block every non-local request (the web fonts are the only external
requests the app makes), and fail on uncaught page errors. It listens on port 4183; set `E2E_PORT` to use another.
Tests marked `test.fail()` assert the correct behaviour for a known open bug (linked in a comment) and will fail once the
bug is fixed, which is the cue to remove the marker.

GitHub Actions (`.github/workflows/ci.yml`, job `test`) runs `npm ci`, build, unit tests and E2E on every pull request and
push to `main`, and caches the Chromium download by Playwright version. `vercel.json` deploys only `main`; pull request
branches get no Vercel preview.

Light and dark themes follow [Material Design 3](https://m3.material.io/).
