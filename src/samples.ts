/** Built-in Spark / Databricks plan samples for PlanLens demos. */

export type Sample = { id: string; label: string; blurb: string; text: string }

export const SAMPLES: Sample[] = [
  {
    id: 'missed-broadcast',
    label: 'Missed broadcast',
    blurb: 'Sort-merge join with a small dimension table that should be broadcast.',
    text: `== Optimized Logical Plan ==
Join [id#12 = id#21], Inner
:- Relation spark_catalog.default.orders[id#12,amount#13,ts#14] parquet, Statistics(sizeInBytes=12.4 GiB, rowCount=8.2E7)
+- Relation spark_catalog.default.dim_customer[id#21,segment#22] parquet, Statistics(sizeInBytes=18.5 MiB, rowCount=2.4E5)

== Physical Plan ==
*(5) SortMergeJoin [id#12], [id#21], Inner
:- *(2) Sort [id#12 ASC NULLS FIRST], false, 0
:  +- Exchange hashpartitioning(id#12, 200), ENSURE_REQUIREMENTS, [plan_id=41]
:     +- *(1) ColumnarToRow
:        +- FileScan parquet spark_catalog.default.orders[id#12,amount#13,ts#14] Batched: true, DataFilters: [], Format: Parquet, Location: InMemoryFileIndex(1 paths)[file:/data/orders], PartitionFilters: [], PushedFilters: [], ReadSchema: struct<id:bigint,amount:double,ts:timestamp>
+- *(4) Sort [id#21 ASC NULLS FIRST], false, 0
   +- Exchange hashpartitioning(id#21, 200), ENSURE_REQUIREMENTS, [plan_id=42]
      +- *(3) ColumnarToRow
         +- FileScan parquet spark_catalog.default.dim_customer[id#21,segment#22] Batched: true, DataFilters: [], Format: Parquet, Location: InMemoryFileIndex(1 paths)[file:/data/dim_customer], PartitionFilters: [], PushedFilters: [], ReadSchema: struct<id:bigint,segment:string>
`,
  },
  {
    id: 'shuffle-join',
    label: 'Shuffle join',
    blurb: 'Two large tables joined via shuffle + sort-merge (no small side).',
    text: `== Physical Plan ==
AdaptiveSparkPlan isFinalPlan=false
+- SortMergeJoin [user_id#3 = user_id#11], Inner
   :- Sort [user_id#3 ASC NULLS FIRST], false, 0
   :  +- Exchange hashpartitioning(user_id#3, 200), ENSURE_REQUIREMENTS, [plan_id=11]
   :     +- FileScan parquet spark_catalog.default.events[user_id#3,event#4,ts#5] Batched: true, DataFilters: [], Format: Parquet, Location: InMemoryFileIndex(1 paths)[file:/data/events], PartitionFilters: [], PushedFilters: [], ReadSchema: struct<user_id:bigint,event:string,ts:timestamp>
   +- Sort [user_id#11 ASC NULLS FIRST], false, 0
      +- Exchange hashpartitioning(user_id#11, 200), ENSURE_REQUIREMENTS, [plan_id=12]
         +- FileScan parquet spark_catalog.default.sessions[user_id#11,session_id#12] Batched: true, DataFilters: [], Format: Parquet, Location: InMemoryFileIndex(1 paths)[file:/data/sessions], PartitionFilters: [], PushedFilters: [], ReadSchema: struct<user_id:bigint,session_id:string>
`,
  },
  {
    id: 'skew-hint',
    label: 'Data skew hints',
    blurb: 'Skewed join key shuffled twice — candidate for SKEW / AQE skew split.',
    text: `== Physical Plan ==
AdaptiveSparkPlan isFinalPlan=false
+- *(6) HashAggregate(keys=[country#7], functions=[count(1)])
   +- Exchange hashpartitioning(country#7, 200), ENSURE_REQUIREMENTS, [plan_id=30]
      +- *(5) HashAggregate(keys=[country#7], functions=[partial_count(1)])
         +- *(5) Project [country#7]
            +- *(5) SortMergeJoin [user_id#1 = user_id#11], Inner
               :- *(2) Sort [user_id#1 ASC NULLS FIRST], false, 0
               :  +- Exchange hashpartitioning(user_id#1, 200), ENSURE_REQUIREMENTS, [plan_id=21]
               :     +- Exchange hashpartitioning(user_id#1, 400), REPARTITION_BY_COL, [plan_id=20]
               :        +- *(1) ColumnarToRow
               :           +- FileScan parquet spark_catalog.default.clicks[user_id#1,country#7,ts#8] Batched: true, DataFilters: [], Format: Parquet, Location: InMemoryFileIndex(1 paths)[file:/data/clicks], PartitionFilters: [], PushedFilters: [], ReadSchema: struct<user_id:bigint,country:string,ts:timestamp>
               +- *(4) Sort [user_id#11 ASC NULLS FIRST], false, 0
                  +- Exchange hashpartitioning(user_id#11, 200), ENSURE_REQUIREMENTS, [plan_id=22]
                     +- *(3) ColumnarToRow
                        +- FileScan parquet spark_catalog.default.users[user_id#11,tier#12] Batched: true, DataFilters: [], Format: Parquet, Location: InMemoryFileIndex(1 paths)[file:/data/users], PartitionFilters: [], PushedFilters: [], ReadSchema: struct<user_id:bigint,tier:string>
`,
  },
  {
    id: 'pandas-udf',
    label: 'Pandas / Python UDF',
    blurb: 'Row-at-a-time BatchEvalPython blocks pushdown and codegen.',
    text: `== Physical Plan ==
*(2) Project [id#1, score#10]
+- BatchEvalPython [score_udf(features#2)], [pythonUDF0#9]
   +- *(1) Project [id#1, features#2, pythonUDF0#9 AS score#10]
      +- *(1) Filter (pythonUDF0#9 > 0.5)
         +- BatchEvalPython [score_udf(features#2)], [pythonUDF0#9]
            +- FileScan parquet spark_catalog.default.features[id#1,features#2] Batched: true, DataFilters: [], Format: Parquet, Location: InMemoryFileIndex(1 paths)[file:/data/features], PartitionFilters: [], PushedFilters: [], ReadSchema: struct<id:bigint,features:array<double>>
`,
  },
  {
    id: 'partition-scan',
    label: 'Partition scan',
    blurb: 'Partitioned table with empty PartitionFilters — full partition listing.',
    text: `== Physical Plan ==
*(1) ColumnarToRow
+- FileScan parquet spark_catalog.default.events[date#1, user_id#2, event#3, payload#4] Batched: true, DataFilters: [], Format: Parquet, Location: CatalogFileIndex(1 paths)[dbfs:/tables/events], PartitionFilters: [], PushedFilters: [], ReadSchema: struct<user_id:bigint,event:string,payload:string>
`,
  },
  {
    id: 'broadcast-fixed',
    label: 'Broadcast (fixed)',
    blurb: 'Same join after BROADCAST hint — good baseline for A/B compare.',
    text: `== Optimized Logical Plan ==
Join [id#12 = id#21], Inner
:- Relation spark_catalog.default.orders[id#12,amount#13,ts#14] parquet, Statistics(sizeInBytes=12.4 GiB, rowCount=8.2E7)
+- Relation spark_catalog.default.dim_customer[id#21,segment#22] parquet, Statistics(sizeInBytes=18.5 MiB, rowCount=2.4E5)

== Physical Plan ==
*(3) BroadcastHashJoin [id#12], [id#21], Inner, BuildRight
:- *(1) ColumnarToRow
:  +- FileScan parquet spark_catalog.default.orders[id#12,amount#13,ts#14] Batched: true, DataFilters: [], Format: Parquet, Location: InMemoryFileIndex(1 paths)[file:/data/orders], PartitionFilters: [], PushedFilters: [], ReadSchema: struct<id:bigint,amount:double,ts:timestamp>
+- BroadcastExchange HashedRelationBroadcastMode(List(input[0, bigint, true]),false), [plan_id=50]
   +- *(2) ColumnarToRow
      +- FileScan parquet spark_catalog.default.dim_customer[id#21,segment#22] Batched: true, DataFilters: [], Format: Parquet, Location: InMemoryFileIndex(1 paths)[file:/data/dim_customer], PartitionFilters: [], PushedFilters: [], ReadSchema: struct<id:bigint,segment:string>
`,
  },
]
