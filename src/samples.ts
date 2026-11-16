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
  {
    id: 'tpcds-q3',
    label: 'TPC-DS q3 (real)',
    blurb: "Apache Spark's approved EXPLAIN FORMATTED plan for TPC-DS q3 (Apache-2.0), unedited.",
    text: `== Physical Plan ==
TakeOrderedAndProject (21)
+- * HashAggregate (20)
   +- Exchange (19)
      +- * HashAggregate (18)
         +- * Project (17)
            +- * BroadcastHashJoin Inner BuildRight (16)
               :- * Project (10)
               :  +- * BroadcastHashJoin Inner BuildRight (9)
               :     :- * Project (4)
               :     :  +- * Filter (3)
               :     :     +- * ColumnarToRow (2)
               :     :        +- Scan parquet spark_catalog.default.date_dim (1)
               :     +- BroadcastExchange (8)
               :        +- * Filter (7)
               :           +- * ColumnarToRow (6)
               :              +- Scan parquet spark_catalog.default.store_sales (5)
               +- BroadcastExchange (15)
                  +- * Project (14)
                     +- * Filter (13)
                        +- * ColumnarToRow (12)
                           +- Scan parquet spark_catalog.default.item (11)


(1) Scan parquet spark_catalog.default.date_dim
Output [3]: [d_date_sk#1, d_year#2, d_moy#3]
Batched: true
Location [not included in comparison]/{warehouse_dir}/date_dim]
PushedFilters: [IsNotNull(d_moy), EqualTo(d_moy,11), IsNotNull(d_date_sk)]
ReadSchema: struct<d_date_sk:int,d_year:int,d_moy:int>

(2) ColumnarToRow [codegen id : 3]
Input [3]: [d_date_sk#1, d_year#2, d_moy#3]

(3) Filter [codegen id : 3]
Input [3]: [d_date_sk#1, d_year#2, d_moy#3]
Condition : ((isnotnull(d_moy#3) AND (d_moy#3 = 11)) AND isnotnull(d_date_sk#1))

(4) Project [codegen id : 3]
Output [2]: [d_date_sk#1, d_year#2]
Input [3]: [d_date_sk#1, d_year#2, d_moy#3]

(5) Scan parquet spark_catalog.default.store_sales
Output [3]: [ss_item_sk#4, ss_ext_sales_price#5, ss_sold_date_sk#6]
Batched: true
Location: InMemoryFileIndex []
PartitionFilters: [isnotnull(ss_sold_date_sk#6), dynamicpruningexpression(true)]
PushedFilters: [IsNotNull(ss_item_sk)]
ReadSchema: struct<ss_item_sk:int,ss_ext_sales_price:decimal(7,2)>

(6) ColumnarToRow [codegen id : 1]
Input [3]: [ss_item_sk#4, ss_ext_sales_price#5, ss_sold_date_sk#6]

(7) Filter [codegen id : 1]
Input [3]: [ss_item_sk#4, ss_ext_sales_price#5, ss_sold_date_sk#6]
Condition : isnotnull(ss_item_sk#4)

(8) BroadcastExchange
Input [3]: [ss_item_sk#4, ss_ext_sales_price#5, ss_sold_date_sk#6]
Arguments: HashedRelationBroadcastMode(List(cast(input[2, int, true] as bigint)),false), [plan_id=1]

(9) BroadcastHashJoin [codegen id : 3]
Left keys [1]: [d_date_sk#1]
Right keys [1]: [ss_sold_date_sk#6]
Join type: Inner
Join condition: None

(10) Project [codegen id : 3]
Output [3]: [d_year#2, ss_item_sk#4, ss_ext_sales_price#5]
Input [5]: [d_date_sk#1, d_year#2, ss_item_sk#4, ss_ext_sales_price#5, ss_sold_date_sk#6]

(11) Scan parquet spark_catalog.default.item
Output [4]: [i_item_sk#7, i_brand_id#8, i_brand#9, i_manufact_id#10]
Batched: true
Location [not included in comparison]/{warehouse_dir}/item]
PushedFilters: [IsNotNull(i_manufact_id), EqualTo(i_manufact_id,128), IsNotNull(i_item_sk)]
ReadSchema: struct<i_item_sk:int,i_brand_id:int,i_brand:string,i_manufact_id:int>

(12) ColumnarToRow [codegen id : 2]
Input [4]: [i_item_sk#7, i_brand_id#8, i_brand#9, i_manufact_id#10]

(13) Filter [codegen id : 2]
Input [4]: [i_item_sk#7, i_brand_id#8, i_brand#9, i_manufact_id#10]
Condition : ((isnotnull(i_manufact_id#10) AND (i_manufact_id#10 = 128)) AND isnotnull(i_item_sk#7))

(14) Project [codegen id : 2]
Output [3]: [i_item_sk#7, i_brand_id#8, i_brand#9]
Input [4]: [i_item_sk#7, i_brand_id#8, i_brand#9, i_manufact_id#10]

(15) BroadcastExchange
Input [3]: [i_item_sk#7, i_brand_id#8, i_brand#9]
Arguments: HashedRelationBroadcastMode(List(cast(input[0, int, true] as bigint)),false), [plan_id=2]

(16) BroadcastHashJoin [codegen id : 3]
Left keys [1]: [ss_item_sk#4]
Right keys [1]: [i_item_sk#7]
Join type: Inner
Join condition: None

(17) Project [codegen id : 3]
Output [4]: [d_year#2, ss_ext_sales_price#5, i_brand_id#8, i_brand#9]
Input [6]: [d_year#2, ss_item_sk#4, ss_ext_sales_price#5, i_item_sk#7, i_brand_id#8, i_brand#9]

(18) HashAggregate [codegen id : 3]
Input [4]: [d_year#2, ss_ext_sales_price#5, i_brand_id#8, i_brand#9]
Keys [3]: [d_year#2, i_brand#9, i_brand_id#8]
Functions [1]: [partial_sum(UnscaledValue(ss_ext_sales_price#5))]
Aggregate Attributes [1]: [sum#11]
Results [4]: [d_year#2, i_brand#9, i_brand_id#8, sum#12]

(19) Exchange
Input [4]: [d_year#2, i_brand#9, i_brand_id#8, sum#12]
Arguments: hashpartitioning(d_year#2, i_brand#9, i_brand_id#8, 5), ENSURE_REQUIREMENTS, [plan_id=3]

(20) HashAggregate [codegen id : 4]
Input [4]: [d_year#2, i_brand#9, i_brand_id#8, sum#12]
Keys [3]: [d_year#2, i_brand#9, i_brand_id#8]
Functions [1]: [sum(UnscaledValue(ss_ext_sales_price#5))]
Aggregate Attributes [1]: [sum(UnscaledValue(ss_ext_sales_price#5))#13]
Results [4]: [d_year#2, i_brand_id#8 AS brand_id#14, i_brand#9 AS brand#15, MakeDecimal(sum(UnscaledValue(ss_ext_sales_price#5))#13,17,2) AS sum_agg#16]

(21) TakeOrderedAndProject
Input [4]: [d_year#2, brand_id#14, brand#15, sum_agg#16]
Arguments: 100, [d_year#2 ASC NULLS FIRST, sum_agg#16 DESC NULLS LAST, brand_id#14 ASC NULLS FIRST], [d_year#2, brand_id#14, brand#15, sum_agg#16]

`,
  },
]
