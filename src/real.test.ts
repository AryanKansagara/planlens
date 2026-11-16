// Real plan text. fixtures/tpcds-q3-formatted.txt is Apache Spark's approved TPC-DS q3 plan
// (sql/core/src/test/resources/tpcds-plan-stability/approved-plans-v1_4/q3/explain.txt, Apache-2.0).
// The other inputs follow the layout of the Spark SQL EXPLAIN reference page and Databricks Photon output.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { analyze, fmtBytes, fmtCount, parsePlan, summarize, walk } from './plan.ts'

const q3 = readFileSync(new URL('./fixtures/tpcds-q3-formatted.txt', import.meta.url), 'utf8')

test('Spark TPC-DS q3 formatted plan: structure, codegen stages and pruning', () => {
  const p = parsePlan(q3)
  assert.equal(p.mode, 'formatted')
  const s = summarize(p.physical)
  assert.deepEqual(s.tables.map((t) => t.split('.').pop()).sort(), ['date_dim', 'item', 'store_sales'])
  assert.equal(s.broadcasts, 2)
  assert.equal(s.shuffles, 1)
  assert.equal(s.codegenStages, 4)
  assert.equal(s.joins['BroadcastHashJoin Inner'], 2)
  let ops = 0
  walk(p.physical, (n) => { if (n.opId !== undefined) ops++ })
  assert.equal(ops, 21) // operators (1)..(21) in the plan
  const ids = analyze(p).map((f) => f.id)
  assert.ok(ids.includes('good-prune')) // store_sales is pruned via ss_sold_date_sk
  assert.ok(!ids.some((i) => i.startsWith('no-prune')))
})

const TABLE = `spark-sql> EXPLAIN select k, sum(v) from values (1, 2), (1, 3) t(k, v) group by k;
+----------------------------------------------------+
|                                                plan|
+----------------------------------------------------+
| == Physical Plan ==
 *(2) HashAggregate(keys=[k#33], functions=[sum(cast(v#34 as bigint))])
 +- Exchange hashpartitioning(k#33, 200), true, [id=#59]
    +- *(1) HashAggregate(keys=[k#33], functions=[partial_sum(cast(v#34 as bigint))])
       +- *(1) LocalTableScan [k#33, v#34]
|
+----------------------------------------------------+`

test('bordered EXPLAIN table output (spark-sql / show()) parses like plain text', () => {
  const p = parsePlan(TABLE)
  const names: string[] = []
  walk(p.physical, (n) => { names.push(n.name) })
  assert.deepEqual(names, ['HashAggregate', 'Exchange', 'HashAggregate', 'LocalTableScan'])
  assert.equal(p.physical.codegen, 2)
  assert.equal(p.physical.children[0].attrs.Partitioning, 'hashpartitioning(k#33, 200)')
})

test('show(truncate=False) cell with | only on the first and last line', () => {
  const p = parsePlan('|== Physical Plan ==\n*(1) Project [id#0L]\n+- *(1) Range (0, 10, step=1, splits=8)|')
  assert.equal(p.physical.name, 'Project')
  assert.equal(p.physical.children[0].name, 'Range')
})

test('codegen marker without a space (*Project) is recognised', () => {
  const p = parsePlan('== Physical Plan ==\n*Project [key#1]\n+- *Filter (key#1 > 1)\n   +- *ColumnarToRow\n      +- FileScan parquet default.t[key#1] Batched: true, DataFilters: [], Format: Parquet, Location: InMemoryFileIndex(1 paths)[file:/t], PartitionFilters: [], PushedFilters: [GreaterThan(key,1)], ReadSchema: struct<key:int>')
  assert.equal(p.physical.name, 'Project')
  assert.equal(p.physical.codegen, 0)
  assert.equal(p.physical.children[0].name, 'Filter')
})

const PHOTON = `== Physical Plan ==
AdaptiveSparkPlan isFinalPlan=false
+- == Initial Plan ==
   ColumnarToRow
   +- PhotonResultStage
      +- PhotonGroupingAgg(keys=[pickup_zip#10], functions=[finalmerge_count(merge count#25L) AS count(1)#22L])
         +- PhotonShuffleExchangeSource
            +- PhotonShuffleMapStage
               +- PhotonShuffleExchangeSink hashpartitioning(pickup_zip#10, 1024)
                  +- PhotonGroupingAgg(keys=[pickup_zip#10], functions=[partial_count(1) AS count#25L])
                     +- PhotonScan parquet samples.nyctaxi.trips[pickup_zip#10,tpep_pickup_datetime#11] DataFilters: [], DictionaryFilters: [], Format: parquet, Location: PreparedDeltaFileIndex(1 paths)[dbfs:/databricks-datasets/nyctaxi-with-zipcodes/subsampled], PartitionFilters: [], ReadSchema: struct<pickup_zip:int>, RequiredDataFilters: []`

test('Databricks Photon plan: PhotonScan is a scan, sink counts as one shuffle', () => {
  const p = parsePlan(PHOTON)
  const s = summarize(p.physical)
  assert.equal(s.aqe, 'initial')
  // A lone "Initial Plan" (no Final Plan yet) is the plan, so it must still be counted.
  assert.equal(s.shuffles, 1)
  assert.equal(s.scans, 1)
  const fs = s
  assert.deepEqual(fs.tables, ['samples.nyctaxi.trips'])
})

test('Photon filter on a wrapped column is reported as not pushed down', () => {
  const p = parsePlan(`== Physical Plan ==
PhotonFilter (cast(ts#1 as string) LIKE 2024%)
+- PhotonScan parquet main.sales.orders[id#0,ts#1] DataFilters: [], DictionaryFilters: [], Format: parquet, Location: PreparedDeltaFileIndex(1 paths)[s3://bucket/orders], PartitionFilters: [], PushedFilters: [], ReadSchema: struct<id:bigint,ts:timestamp>`)
  assert.ok(analyze(p).some((f) => f.id === 'not-pushed:main.sales.orders'))
})

test('count and byte formatting never print 1000.0K or 1024.0 KiB', () => {
  assert.equal(fmtCount(999), '999')
  assert.equal(fmtCount(999_960), '1.00M')
  assert.equal(fmtCount(9_996), '10.0K')
  assert.equal(fmtCount(1_500), '1.50K')
  assert.equal(fmtBytes(1023), '1023 B')
  assert.equal(fmtBytes(1024 * 1024 - 10), '1.0 MiB')
  assert.equal(fmtBytes(10 * 2 ** 20), '10.0 MiB')
})

test('text that is not a plan is rejected with guidance', () => {
  assert.throws(() => parsePlan('hello world\nnothing here'), /does not look like a Spark plan|No plan found/)
})

test('after execution only the Final Plan is counted, not the Initial Plan', () => {
  const p = parsePlan(`== Physical Plan ==
AdaptiveSparkPlan isFinalPlan=true
+- == Final Plan ==
   *(2) HashAggregate(keys=[k#1], functions=[count(1)])
   +- AQEShuffleRead coalesced
      +- ShuffleQueryStage 0
         +- Exchange hashpartitioning(k#1, 200), ENSURE_REQUIREMENTS, [plan_id=10]
            +- *(1) HashAggregate(keys=[k#1], functions=[partial_count(1)])
               +- *(1) Range (0, 100, step=1, splits=8)
+- == Initial Plan ==
   HashAggregate(keys=[k#1], functions=[count(1)])
   +- Exchange hashpartitioning(k#1, 200), ENSURE_REQUIREMENTS, [plan_id=5]
      +- HashAggregate(keys=[k#1], functions=[partial_count(1)])
         +- Range (0, 100, step=1, splits=8)`)
  const s = summarize(p.physical)
  assert.equal(s.aqe, 'final')
  assert.equal(s.shuffles, 1)
})
