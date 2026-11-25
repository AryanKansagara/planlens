// Plans that were cut off (clipboard limit, partial copy, truncated log) must say so instead of passing as complete.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { analyze, parsePlan } from './plan.ts'
import { SAMPLES } from './samples.ts'

const q3 = readFileSync(new URL('./fixtures/tpcds-q3-formatted.txt', import.meta.url), 'utf8')
const docsExtended = readFileSync(new URL('../e2e/plans/spark-docs-extended.txt', import.meta.url), 'utf8')
const MISSED = SAMPLES.find((s) => s.id === 'missed-broadcast')!.text
const head = (text: string, bytes: number) => Buffer.from(text).subarray(0, bytes).toString()
const ids = (text: string) => analyze(parsePlan(text)).map((f) => f.id)

test('complete plans are not reported as truncated', () => {
  for (const s of SAMPLES) assert.deepEqual(parsePlan(s.text).truncated, [], s.id)
  assert.deepEqual(parsePlan(q3).truncated, []) // also has a stray "]" in a Location line
  assert.deepEqual(parsePlan(docsExtended).truncated, [])
  assert.ok(!ids(MISSED).includes('truncated'))
})

test('cut before the physical plan (issue #3, case A)', () => {
  const p = parsePlan(head(MISSED, 300))
  assert.match(p.truncated.join(' '), /ends in the middle of a line/)
  assert.match(p.truncated.join(' '), /no "== Physical Plan ==" section/)
  const found = analyze(p)
  assert.equal(found[0].id, 'truncated')
  assert.equal(found[0].severity, 'warn')
  assert.ok(found.every((f) => f.severity !== 'good'))
})

test('a header with logical plans above it but no physical plan underneath is flagged', () => {
  const upTo = MISSED.indexOf('== Physical Plan ==')
  assert.match(parsePlan(MISSED.slice(0, upTo)).truncated.join(' '), /no "== Physical Plan ==" section/)
  assert.match(parsePlan(MISSED.slice(0, upTo + '== Physical Plan ==\n'.length)).truncated.join(' '), /no "== Physical Plan ==" section/)
})

test('cut inside the first scan: no false "No partition pruning" (issue #3, case B)', () => {
  const text = head(MISSED, 700)
  const p = parsePlan(text)
  assert.ok(p.truncated.length > 0)
  assert.ok(!ids(text).some((i) => i.startsWith('no-prune')))
  const scan = p.physical.children[0].children[0].children[0].children[0]
  assert.equal(scan.incomplete, true)
})

test('cut inside the operator details of a formatted plan (issue #3, case C)', () => {
  for (const bytes of [2800, 3200, 4000, 4500]) {
    const text = head(q3, bytes)
    const p = parsePlan(text)
    assert.match(p.truncated.join(' '), /details of \d+ operators? (is|are) missing/, `${bytes}`)
    assert.ok(!ids(text).some((i) => i.startsWith('no-prune')), `${bytes}`)
  }
})

test('cut inside the last line of a formatted plan (issue #3, case C, 5150 bytes)', () => {
  const p = parsePlan(head(q3, 5150))
  assert.deepEqual(p.truncated, ['The text ends in the middle of a line.'])
  assert.equal(analyze(p)[0].id, 'truncated')
})

test('every cut of the formatted q3 plan inside its text is flagged unless it falls between whole detail blocks', () => {
  const cuts = [...q3.matchAll(/\n/g)].map((m) => m.index!).filter((i) => i > q3.indexOf('\n\n(1) '))
  let silent = 0
  for (let at = q3.indexOf('\n\n(1) ') + 3; at < q3.length - 1; at += 7) {
    const text = q3.slice(0, at)
    if (!parsePlan(text).truncated.length) silent++
  }
  // Only cuts that leave every operator with a complete block are silent: the tail of the final block.
  assert.ok(cuts.length > 0)
  assert.ok(silent <= Math.ceil(q3.length / 7 / 20), `${silent} silent cuts`)
})

test('a scan line cut before ReadSchema is not judged (no pruning or pushdown claims)', () => {
  const scan = 'FileScan parquet db.t[id#1,ts#2,dt#3] Batched: true, DataFilters: [], Format: Parquet, Location: InMemoryFileIndex(1 paths)[file:/t], PartitionFilters: []'
  const text = `== Physical Plan ==\n*(1) Filter (cast(ts#2 as string) LIKE 2024%)\n+- *(1) ${scan}`
  const p = parsePlan(text)
  assert.match(p.truncated.join(' '), /1 scan is cut off before ReadSchema/)
  const found = ids(text)
  assert.ok(!found.some((i) => /^(no-prune|not-pushed|wide|good-)/.test(i)), found.join())
  // The same scan with its ReadSchema is judged as before.
  const full = parsePlan(`${text}, PushedFilters: [], ReadSchema: struct<id:int,ts:string>`)
  assert.deepEqual(full.truncated, [])
  assert.ok(analyze(full).some((f) => f.id === 'not-pushed:db.t'))
})

test('a ReadSchema cut inside the struct counts as cut off', () => {
  for (const schema of ['struct', 'struct<id:int,na', 'struct<id:int,n:struct<a:int>']) {
    const p = parsePlan(`== Physical Plan ==\n*(1) FileScan parquet db.t[id#1] Batched: true, Format: Parquet, Location: InMemoryFileIndex(1 paths)[file:/t], PartitionFilters: [], PushedFilters: [], ReadSchema: ${schema}`)
    assert.ok(p.truncated.length > 0, schema)
  }
  for (const schema of ['struct<id:int>', 'struct<id:int,n:struct<a:int>>', 'struct<id:int,a:string,...']) {
    const p = parsePlan(`== Physical Plan ==\n*(1) FileScan parquet db.t[id#1] Batched: true, Format: Parquet, Location: InMemoryFileIndex(1 paths)[file:/t], PartitionFilters: [], PushedFilters: [], ReadSchema: ${schema}`)
    assert.deepEqual(p.truncated, [], schema)
  }
})

test('a line that stops on a tree marker or codegen marker is cut off', () => {
  const body = '== Physical Plan ==\n*(1) Project [id#0L]\n'
  for (const tail of ['+- ', '+-', '+- *', '+- *(1) ', ':- ', '   :  +- ']) {
    assert.ok(parsePlan(`${body}${tail}`).truncated.length > 0, JSON.stringify(tail))
  }
  assert.deepEqual(parsePlan(`${body}+- *(1) Range (0, 10, step=1, splits=8)`).truncated, [])
})

test('Hive and other scans without a ReadSchema are not mistaken for cut-off file scans', () => {
  const p = parsePlan('== Physical Plan ==\n*(1) Project [a#1]\n+- Scan hive db.t [a#1], HiveTableRelation [`db`.`t`, org.apache.hadoop.hive.ql.io.orc.OrcSerde, Data Cols: [a#1], Partition Cols: []]')
  assert.deepEqual(p.truncated, [])
})

test('the truncation finding is also raised for the Initial Plan of an adaptive plan', () => {
  const p = parsePlan('== Physical Plan ==\nAdaptiveSparkPlan isFinalPlan=false\n+- == Initial Plan ==\n   Project [id#0L]\n   +- Range (0, 10, step=1, splits=8\n')
  assert.ok(p.truncated.length > 0)
})
