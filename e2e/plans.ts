import { readFileSync } from 'node:fs'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

// Verbatim from the Spark SQL EXPLAIN reference (https://spark.apache.org/docs/latest/sql-ref-syntax-qry-explain.html,
// "Default Output", "Using Extended", "Using Formatted"), including the spark-sql prompt line and the console table borders.
export const docsSimple = read('./plans/spark-docs-simple.txt')
export const docsExtended = read('./plans/spark-docs-extended.txt')
export const docsFormatted = read('./plans/spark-docs-formatted.txt')

// Apache Spark's approved TPC-DS q3 EXPLAIN FORMATTED output (Apache-2.0), the same file the unit tests and the "real" sample use:
// sql/core/src/test/resources/tpcds-plan-stability/approved-plans-v1_4/q3/explain.txt
export const tpcdsQ3 = read('../src/fixtures/tpcds-q3-formatted.txt')

// Adaptive plans, laid out as AdaptiveSparkPlanExec.generateTreeString prints them: the "Final Plan" (or "Current Plan" while
// the query is still running) followed by the "Initial Plan"
// (https://github.com/apache/spark/blob/master/sql/core/src/main/scala/org/apache/spark/sql/execution/adaptive/AdaptiveSparkPlanExec.scala).
export const aqeFinal = read('./plans/aqe-final.txt')
export const aqeCurrent = read('./plans/aqe-current.txt')

// A plan printed before anything ran: only the "Initial Plan" exists, so it is the plan.
export const aqeInitialOnly = `== Physical Plan ==
AdaptiveSparkPlan isFinalPlan=false
+- == Initial Plan ==
   HashAggregate(keys=[k#1], functions=[count(1)])
   +- Exchange hashpartitioning(k#1, 200), ENSURE_REQUIREMENTS, [plan_id=5]
      +- HashAggregate(keys=[k#1], functions=[partial_count(1)])
         +- Range (0, 100, step=1, splits=8)
`
