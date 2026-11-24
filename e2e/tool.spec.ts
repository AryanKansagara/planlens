import type { Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures.ts'
import { aqeCurrent, aqeFinal, aqeInitialOnly, docsExtended, docsFormatted, docsSimple, tpcdsQ3 } from './plans.ts'
import { SAMPLES } from '../src/samples.ts'

// Everything here is synthetic or comes from Apache Spark's own docs and test resources (see plans.ts).
// Tests marked `test.fail()` assert the behaviour a user should get; they pass while the filed app bug exists and
// start failing when it is fixed, which is the cue to remove the marker.

const planA = (page: Page) => page.getByLabel('Plan A text')
const planB = (page: Page) => page.getByLabel('Plan B text')
const stat = (page: Page, label: string) => page.locator('.stat', { has: page.getByText(label, { exact: true }) }).locator('.value')
const tab = (page: Page, name: string | RegExp) => page.getByRole('tab', { name })
const findingTitles = (page: Page) => page.locator('.finding strong').allTextContents()
const parsedAs = (page: Page) => page.locator('label.field', { has: page.getByLabel('Plan A text') }).getByText(/^Parsed as/)
// The panel below the tree that shows the selected operator's attributes.
const detailFor = (page: Page, name: string | RegExp) => page.locator('div.panel', { has: page.getByRole('heading', { name, level: 3 }) })
const errorBadge = (page: Page) => page.locator('label.field').first().locator('.badge.bad')

async function openWith(page: Page, text: string) {
  await page.goto('/app')
  await planA(page).fill(text)
}

async function counts(page: Page) {
  const labels = ['Operators', 'Scans', 'Shuffles', 'Broadcasts', 'Sorts', 'Codegen stages', 'AQE']
  const out: Record<string, string> = {}
  for (const l of labels) out[l] = (await stat(page, l).innerText()).trim()
  return out
}

test('landing page leads to the tool, and the docs page renders', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('The Spark UI')
  await page.getByRole('button', { name: 'Try this' }).first().click()
  await expect(page).toHaveURL(/\/app$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('See what your Spark plan is really doing')
  await expect(page.getByText('Paste a plan or pick a sample to get started.')).toBeVisible()
  // No plan, no analysis.
  await expect(page.getByRole('tab')).toHaveCount(0)

  await page.goto('/docs')
  await expect(page.getByRole('heading', { name: 'What you can paste' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Rules and thresholds' })).toBeVisible()
})

// What each built-in sample must produce today: how it parses, the summary numbers, and every finding it raises.
const SAMPLE_EXPECTED: Record<string, { mode: string; sections: string; counts: Record<string, string>; findings: (string | RegExp)[] }> = {
  'missed-broadcast': {
    mode: 'cost', sections: '2 sections',
    counts: { Operators: '9', Scans: '2', Shuffles: '2', Broadcasts: '0', Sorts: '2', 'Codegen stages': '5', AQE: 'off' },
    findings: [/^SortMergeJoin with a small side \(~18\.5 MiB, dim_customer\): broadcast it$/, 'SortMergeJoin sorts both inputs before joining'],
  },
  'shuffle-join': {
    mode: 'simple', sections: '1 section',
    counts: { Operators: '8', Scans: '2', Shuffles: '2', Broadcasts: '0', Sorts: '2', 'Codegen stages': '0', AQE: 'initial' },
    findings: ['SortMergeJoin sorts both inputs before joining', 'Adaptive plan not final (isFinalPlan=false)'],
  },
  'skew-hint': {
    mode: 'simple', sections: '1 section',
    counts: { Operators: '15', Scans: '2', Shuffles: '4', Broadcasts: '0', Sorts: '2', 'Codegen stages': '6', AQE: 'initial' },
    findings: ['Data is shuffled twice on the same keys', 'SortMergeJoin sorts both inputs before joining', 'Adaptive plan not final (isFinalPlan=false)'],
  },
  'pandas-udf': {
    mode: 'simple', sections: '1 section',
    counts: { Operators: '6', Scans: '1', Shuffles: '0', Broadcasts: '0', Sorts: '0', 'Codegen stages': '2', AQE: 'off' },
    findings: ['Filter on features not pushed down to the scan', 'Row-at-a-time Python UDF (BatchEvalPython)'],
  },
  'partition-scan': {
    mode: 'simple', sections: '1 section',
    counts: { Operators: '2', Scans: '1', Shuffles: '0', Broadcasts: '0', Sorts: '0', 'Codegen stages': '1', AQE: 'off' },
    findings: ['No partition pruning on events'],
  },
  'broadcast-fixed': {
    mode: 'cost', sections: '2 sections',
    counts: { Operators: '6', Scans: '2', Shuffles: '0', Broadcasts: '1', Sorts: '0', 'Codegen stages': '3', AQE: 'off' },
    findings: ['1 broadcast hash join'],
  },
  'tpcds-q3': {
    mode: 'formatted', sections: '1 section',
    counts: { Operators: '21', Scans: '3', Shuffles: '1', Broadcasts: '2', Sorts: '0', 'Codegen stages': '4', AQE: 'off' },
    findings: ['2 broadcast hash joins', /^Filters pushed down on /, /^Partition pruning on /],
  },
}

test('the expectations cover every built-in sample', () => {
  expect(Object.keys(SAMPLE_EXPECTED).sort()).toEqual(SAMPLES.map((s) => s.id).sort())
})

for (const sample of SAMPLES) {
  test(`sample "${sample.label}" opens with its parsed plan and findings`, async ({ page }) => {
    const want = SAMPLE_EXPECTED[sample.id]
    await page.goto('/app')
    await page.getByRole('button', { name: sample.label, exact: true }).click()

    // The text really is in the input, and the sample's description is shown.
    await expect(planA(page)).toHaveValue(sample.text)
    await expect(page.getByText(sample.blurb)).toBeVisible()
    await expect(parsedAs(page)).toHaveText(`Parsed as ${want.mode} · ${want.sections}`)
    expect(await counts(page)).toEqual(want.counts)

    // The Findings tab lists exactly the expected findings, in severity order.
    await tab(page, /^Findings/).click()
    const titles = await findingTitles(page)
    expect(titles).toHaveLength(want.findings.length)
    want.findings.forEach((w, i) => (typeof w === 'string' ? expect(titles[i]).toBe(w) : expect(titles[i]).toMatch(w)))
    await expect(tab(page, /^Findings/)).toHaveText(`Findings (${want.findings.length})`)

    // The Plan tree shows the parsed operators.
    await tab(page, 'Plan tree').click()
    const nodes = await page.locator('.tree .node').count()
    expect(nodes).toBeGreaterThanOrEqual(Number(want.counts.Operators))
  })
}

test('the missed-broadcast finding explains the fix, and "Show in tree" highlights the join', async ({ page }) => {
  await page.goto('/app')
  await page.getByRole('button', { name: 'Missed broadcast', exact: true }).click()
  await tab(page, /^Findings/).click()
  const finding = page.locator('.finding', { hasText: 'broadcast it' })
  await expect(finding).toContainText('Warning')
  await expect(finding.locator('.fix pre')).toContainText('BROADCAST(')
  await expect(finding.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', /spark\.apache\.org/)

  await finding.getByRole('button', { name: 'Show in tree' }).click()
  await expect(tab(page, 'Plan tree')).toHaveAttribute('aria-selected', 'true')
  const hot = page.locator('.tree .node.hot')
  await expect(hot.first()).toContainText('SortMergeJoin')
  await expect(hot.first()).toContainText('Inner')
})

test('paste the spark-sql EXPLAIN table from the Spark docs (simple output)', async ({ page }) => {
  await openWith(page, docsSimple)
  await expect(parsedAs(page)).toHaveText('Parsed as simple · 1 section')
  expect(await counts(page)).toMatchObject({ Operators: '4', Scans: '1', Shuffles: '1', Broadcasts: '0', 'Codegen stages': '2', AQE: 'off' })
  await tab(page, 'Plan tree').click()
  await expect(page.locator('.tree .name')).toHaveText(['HashAggregate', 'Exchange', 'HashAggregate', 'LocalTableScan'])
  // The console table borders and the prompt line are not operators.
  await expect(page.locator('.tree')).not.toContainText('plan')
  await expect(page.locator('.tree')).not.toContainText('EXPLAIN')
})

test('paste EXPLAIN EXTENDED from the Spark docs (parsed, analyzed, optimized, physical)', async ({ page }) => {
  await openWith(page, docsExtended)
  await expect(parsedAs(page)).toHaveText('Parsed as extended · 4 sections')
  // Counts come from the physical plan, not from the three logical plans above it.
  expect(await counts(page)).toMatchObject({ Operators: '4', Scans: '1', Shuffles: '1', 'Codegen stages': '2', AQE: 'off' })
  await tab(page, 'Plan tree').click()
  // The docs page indents the last operator of this example by one space too many; see the test below for the name it gets.
  await expect(page.locator('.tree .name').nth(0)).toHaveText('HashAggregate')
  await expect(page.locator('.tree .name').nth(1)).toHaveText('Exchange')
  await expect(page.locator('.tree .name').nth(2)).toHaveText('HashAggregate')
  await expect(page.locator('.tree .name')).toHaveCount(4)
  await page.locator('.tree .node', { hasText: 'Exchange' }).click()
  await expect(detailFor(page, 'Exchange')).toContainText('hashpartitioning(k#47, 200)')
})

// https://github.com/AryanKansagara/planlens/issues/5
test('known bug #5: an operator line indented one space off still gets its operator name', async ({ page }) => {
  test.fail()
  await openWith(page, docsExtended)
  await tab(page, 'Plan tree').click()
  await expect(page.locator('.tree .name').nth(3)).toHaveText('LocalTableScan')
})

test('paste EXPLAIN FORMATTED from the Spark docs', async ({ page }) => {
  await openWith(page, docsFormatted)
  await expect(parsedAs(page)).toHaveText('Parsed as formatted · 1 section')
  expect(await counts(page)).toMatchObject({ Operators: '4', Scans: '1', Shuffles: '1', 'Codegen stages': '2', AQE: 'off' })
  await tab(page, 'Plan tree').click()
  // Numbered detail blocks are attached to their operators.
  await page.locator('.tree .node', { hasText: 'LocalTableScan' }).click()
  await expect(detailFor(page, 'LocalTableScan')).toContainText('[k#19, v#20]')
})

test('paste Spark\'s own TPC-DS q3 EXPLAIN FORMATTED output', async ({ page }) => {
  await openWith(page, tpcdsQ3)
  await expect(parsedAs(page)).toHaveText('Parsed as formatted · 1 section')
  expect(await counts(page)).toMatchObject({ Operators: '21', Scans: '3', Shuffles: '1', Broadcasts: '2', 'Codegen stages': '4' })
  await expect(page.getByText(/Tables: date_dim, store_sales, item/)).toBeVisible()
  await tab(page, /^Findings/).click()
  // Only good signals: filters pushed down, partitions pruned, broadcast joins. Nothing to warn about.
  await expect(page.locator('.finding:not(.good)')).toHaveCount(0)
  await expect(page.locator('.finding.good')).toHaveCount(3)
  await tab(page, 'Plan tree').click()
  await page.locator('.tree .node', { hasText: 'store_sales' }).click()
  await expect(detailFor(page, /^Scan parquet/)).toContainText('isnotnull(ss_sold_date_sk#6)')
  await page.locator('.tree .node', { hasText: 'date_dim' }).click()
  await expect(detailFor(page, /^Scan parquet/)).toContainText('EqualTo(d_moy,11)')
})

test('an adaptive plan before execution is flagged as not final', async ({ page }) => {
  await page.goto('/app')
  await page.getByRole('button', { name: 'Shuffle join', exact: true }).click()
  await expect(stat(page, 'AQE')).toHaveText('initial')
  await tab(page, /^Findings/).click()
  const f = page.locator('.finding', { hasText: 'isFinalPlan=false' })
  await expect(f).toContainText('Info')
  await expect(f).toContainText('before execution')
})

test('after execution only the Final Plan is counted and the Initial Plan stays out of the numbers', async ({ page }) => {
  await openWith(page, aqeFinal)
  await expect(stat(page, 'AQE')).toHaveText('final')
  // Final: HashAggregate, AQEShuffleRead, ShuffleQueryStage, Exchange, HashAggregate, Range + AdaptiveSparkPlan = 7.
  // The Initial Plan has its own 4 operators and one Exchange, none of which ran.
  expect(await counts(page)).toMatchObject({ Operators: '7', Scans: '1', Shuffles: '1', 'Codegen stages': '2' })
  await tab(page, /^Findings/).click()
  expect(await findingTitles(page)).toEqual(['Final adaptive plan'])
  await expect(page.locator('.finding')).toHaveClass(/good/)

  // Both plans are visible in the tree, under their own headers.
  await tab(page, 'Plan tree').click()
  const names = await page.locator('.tree .name').allTextContents()
  expect(names).toContain('Final Plan')
  expect(names).toContain('Initial Plan')
  expect(names.indexOf('Final Plan')).toBeLessThan(names.indexOf('Initial Plan'))
})

test('a plan that only has an Initial Plan is the plan, so its operators are counted', async ({ page }) => {
  await openWith(page, aqeInitialOnly)
  await expect(stat(page, 'AQE')).toHaveText('initial')
  expect(await counts(page)).toMatchObject({ Operators: '5', Scans: '1', Shuffles: '1' })
  await tab(page, /^Findings/).click()
  expect(await findingTitles(page)).toEqual(['Adaptive plan not final (isFinalPlan=false)'])
})

test('a running adaptive query counts the Current Plan once, not together with the Initial Plan', async ({ page }) => {
  await openWith(page, aqeCurrent)
  await expect(stat(page, 'AQE')).toHaveText('initial')
  // Current Plan: HashAggregate, ShuffleQueryStage, Exchange, HashAggregate, Range + AdaptiveSparkPlan = 6.
  // The Initial Plan has its own 4 operators, one scan and one Exchange; none of them is running.
  expect(await counts(page)).toMatchObject({ Operators: '6', Scans: '1', Shuffles: '1', 'Codegen stages': '1' })
  await tab(page, /^Findings/).click()
  expect(await findingTitles(page)).toEqual(['Adaptive plan not final (isFinalPlan=false)'])

  // Both plans are visible in the tree, under their own headers.
  await tab(page, 'Plan tree').click()
  const names = await page.locator('.tree .name').allTextContents()
  expect(names).toContain('Current Plan')
  expect(names).toContain('Initial Plan')
  expect(names.indexOf('Current Plan')).toBeLessThan(names.indexOf('Initial Plan'))
})

const NOT_A_PLAN = /^(This does not look like a Spark plan|No plan found)/

for (const [name, text] of [
  ['unrelated prose', 'hello world\nnothing here\n'],
  ['a SQL statement', 'SELECT * FROM orders o JOIN customers c ON o.id = c.id'],
  ['JSON', '{"plan": "SELECT 1", "rows": [1,2,3]}'],
  ['only a section header', '== Physical Plan ==\n'],
  ['a header cut off mid-word', '== Physical Pla'],
  ['one operator cut off after two characters', '== Physical Plan ==\n*(1) Fil'],
] as const) {
  test(`${name} is rejected with a message and no analysis`, async ({ page }) => {
    await openWith(page, text)
    await expect(errorBadge(page)).toHaveText(NOT_A_PLAN)
    await expect(page.getByRole('tab')).toHaveCount(0)
    await expect(page.locator('.stat')).toHaveCount(0)
    await expect(page.getByText('No issues flagged')).toHaveCount(0)
    await expect(page.getByText('Nothing flagged')).toHaveCount(0)
    await expect(parsedAs(page)).toHaveCount(0)
  })
}

test('empty and whitespace-only input analyse nothing and say how to start', async ({ page }) => {
  await page.goto('/app')
  await expect(page.getByText('Paste a plan or pick a sample to get started.')).toBeVisible()
  await expect(page.getByRole('tab')).toHaveCount(0)
  await planA(page).fill('   \n\n  \n')
  await expect(page.getByRole('tab')).toHaveCount(0)
  await expect(page.getByText('No issues flagged')).toHaveCount(0)
  await expect(page.getByText('Paste a plan or pick a sample to get started.')).toBeVisible()
  // Clear A appears for any non-empty input and clears it.
  await page.getByRole('button', { name: 'Clear A' }).click()
  await expect(planA(page)).toHaveValue('')
})

test('after a rejected paste, a real plan recovers and "Clear A" resets the page', async ({ page }) => {
  await openWith(page, 'hello world\nnothing here\n')
  await expect(errorBadge(page)).toBeVisible()
  await planA(page).fill(docsSimple)
  await expect(errorBadge(page)).toHaveCount(0)
  await expect(parsedAs(page)).toHaveText('Parsed as simple · 1 section')
  await page.getByRole('button', { name: 'Clear A' }).click()
  await expect(page.getByRole('tab')).toHaveCount(0)
  await expect(page.getByText('Paste a plan or pick a sample to get started.')).toBeVisible()
})

// https://github.com/AryanKansagara/planlens/issues/2
test('known bug #2: unrelated text that contains "+- " lines is rejected instead of shown as a clean plan', async ({ page }) => {
  test.fail()
  await openWith(page, 'Shopping list:\n+- eggs\n+- milk\n   +- 2% fat\n')
  await expect(errorBadge(page)).toHaveText(NOT_A_PLAN)
  await expect(page.getByText('No issues flagged')).toHaveCount(0)
})

// https://github.com/AryanKansagara/planlens/issues/3
const MISSED = SAMPLES.find((s) => s.id === 'missed-broadcast')!.text
test('known bug #3: a plan cut off before its physical plan is not reported as having no problems', async ({ page }) => {
  test.fail()
  await openWith(page, MISSED.slice(0, 300))
  await expect(page.getByText('No issues flagged')).toHaveCount(0)
})

test('known bug #3: a plan cut off inside a scan does not claim the table has no partition pruning', async ({ page }) => {
  test.fail()
  await openWith(page, MISSED.slice(0, 700))
  await tab(page, /^Findings/).click()
  expect((await findingTitles(page)).join('\n')).not.toMatch(/No partition pruning/)
})

test('plan A and plan B compare: the broadcast fix removes both shuffles and the finding', async ({ page }) => {
  await page.goto('/app')
  // Compare needs both sides.
  await expect(tab(page, 'A / B compare')).toHaveCount(0)
  await page.getByRole('button', { name: 'Missed broadcast', exact: true }).click()
  await expect(tab(page, 'A / B compare')).toBeDisabled()
  await page.getByRole('button', { name: 'Load fixed plan as B' }).click()

  await expect(tab(page, 'A / B compare')).toHaveAttribute('aria-selected', 'true')
  await expect(planB(page)).toHaveValue(SAMPLES.find((s) => s.id === 'broadcast-fixed')!.text)
  const row = (label: string) => page.locator('tbody tr', { has: page.getByText(label, { exact: true }) })
  const cells = async (label: string) => (await row(label).first().locator('td').allTextContents()).map((c) => c.trim())
  expect(await cells('Shuffles (Exchange)')).toEqual(['Shuffles (Exchange)', '2', '0', '-2'])
  expect(await cells('Broadcasts')).toEqual(['Broadcasts', '0', '1', '+1'])
  expect(await cells('Sorts')).toEqual(['Sorts', '2', '0', '-2'])
  expect(await cells('Joins')).toEqual(['Joins', '1', '1', '0'])

  const resolved = page.locator('h3', { hasText: 'Resolved in B' })
  await expect(resolved.locator('.badge')).toHaveText('2')
  await expect(page.getByText('SortMergeJoin with a small side', { exact: false }).first()).toBeVisible()
  await expect(page.locator('h3', { hasText: 'Introduced in B' }).locator('.badge')).toHaveText('0')
  await expect(page.getByText('No new findings.')).toBeVisible()

  // Clearing B takes the comparison away again.
  await page.getByRole('button', { name: 'Clear B' }).click()
  await expect(tab(page, 'A / B compare')).toBeDisabled()
  await expect(tab(page, 'Overview')).toBeVisible()
})

test('comparing a plan with itself reports no changes', async ({ page }) => {
  await openWith(page, docsSimple)
  await planB(page).fill(docsSimple)
  await page.getByRole('button', { name: 'Open compare' }).click()
  await expect(page.getByText('No findings cleared.')).toBeVisible()
  await expect(page.getByText('No new findings.')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Operator changes' })).toHaveCount(0)
  for (const row of await page.locator('tbody tr').all()) await expect(row.locator('td').last()).toHaveText('0')
})

test('an unreadable plan B is reported on B and keeps the comparison off', async ({ page }) => {
  await openWith(page, docsSimple)
  await planB(page).fill('hello world')
  await expect(page.locator('label.field').nth(1).locator('.badge.bad')).toHaveText(NOT_A_PLAN)
  await expect(tab(page, 'A / B compare')).toBeDisabled()
  // Plan A is unaffected.
  await expect(parsedAs(page)).toHaveText('Parsed as simple · 1 section')
})

test('plan tree: collapse, expand and inspect an operator', async ({ page }) => {
  await openWith(page, docsSimple)
  await tab(page, 'Plan tree').click()
  const names = page.locator('.tree .name')
  await expect(names).toHaveCount(4)
  await page.getByRole('button', { name: 'Collapse all' }).click()
  await expect(names).toHaveCount(1)
  await page.getByRole('button', { name: 'Expand all' }).click()
  await expect(names).toHaveCount(4)
  await page.locator('.tree .node', { hasText: 'Exchange' }).getByRole('button', { name: 'Collapse' }).click()
  await expect(names).toHaveText(['HashAggregate', 'Exchange'])

  await page.locator('.tree .node', { hasText: 'HashAggregate' }).click()
  const detail = detailFor(page, 'HashAggregate')
  await expect(detail.locator('tbody tr', { hasText: 'Keys' })).toContainText('[k#33]')
  await expect(detail.locator('tbody tr', { hasText: 'Functions' })).toContainText('sum(cast(v#34 as bigint))')
})

test('the theme choice survives a reload, and the plan stays on this device', async ({ page }) => {
  await page.goto('/app')
  const mode = () => page.evaluate(() => document.documentElement.dataset.themeMode)
  expect(await mode()).toBe('light')
  await page.getByRole('button', { name: 'Switch to dark theme' }).click()
  expect(await mode()).toBe('dark')
  await page.reload()
  expect(await mode()).toBe('dark')
  await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeVisible()
  // The choice is shared with the landing page.
  await page.goto('/')
  expect(await mode()).toBe('dark')

  // "Runs entirely in your browser": a pasted plan is not written to any storage and is not restored after a reload.
  await openWith(page, docsSimple)
  await expect(parsedAs(page)).toBeVisible()
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
  expect(stored).not.toContain('HashAggregate')
  expect(stored).not.toContain('k#33')
  await page.reload()
  await expect(planA(page)).toHaveValue('')
  await expect(page.getByRole('tab')).toHaveCount(0)
})

test('analysis makes no network request: a plan is analysed with every external host blocked', async ({ page, blocked }) => {
  const requests: string[] = []
  page.on('request', (r) => { if (!/^(data|blob):/.test(r.url())) requests.push(new URL(r.url()).host) })
  await openWith(page, tpcdsQ3)
  await expect(parsedAs(page)).toBeVisible()
  await tab(page, 'Plan tree').click()
  await tab(page, /^Findings/).click()
  const afterLoad = requests.length
  await planA(page).fill(docsExtended)
  await expect(parsedAs(page)).toHaveText('Parsed as extended · 4 sections')
  // Parsing a new plan adds no request of any kind.
  expect(requests.length).toBe(afterLoad)
  // Everything the page asked for is either this server or one of the two web-font hosts, and the fonts were blocked.
  expect([...new Set(requests)].sort()).toEqual(['127.0.0.1:' + new URL(page.url()).port, ...new Set(blocked)].sort())
})

test.describe('narrow screens', () => {
  test.use({ viewport: { width: 390, height: 800 } })

  test('the tool does not scroll sideways with a wide plan loaded', async ({ page }) => {
    await page.goto('/app')
    await page.getByRole('button', { name: 'TPC-DS q3 (real)', exact: true }).click()
    await expect(stat(page, 'Operators')).toHaveText('21')
    await tab(page, 'Plan tree').click()
    const overflow: Locator = page.locator('html')
    const { scroll, client } = await overflow.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
    expect(scroll).toBeLessThanOrEqual(client)
  })
})
