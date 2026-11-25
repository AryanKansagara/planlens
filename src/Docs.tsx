import { Shell } from './Shell.tsx'
import { BackToHome } from './router.tsx'

const SPARK = 'https://github.com/apache/spark/tree/master/sql/core/src/test/resources'

export default function Docs() {
  return (
    <Shell name="PlanLens" tagline="Spark / Databricks plan analyzer">
      <BackToHome />
      <section className="panel">
        <h2>What you can paste</h2>
        <ul className="advice">
          <li><code>df.explain()</code> / <code>EXPLAIN</code> (physical plan only), <code>explain(True)</code> / <code>EXPLAIN EXTENDED</code> (parsed, analyzed, optimized and physical plans), <code>explain(mode="cost")</code> / <code>EXPLAIN COST</code> (with <code>Statistics(sizeInBytes=…, rowCount=…)</code>) and <code>explain(mode="formatted")</code> / <code>EXPLAIN FORMATTED</code> (operator outline plus numbered details and subqueries).</li>
          <li>Console wrappers are removed for you: the <code>+----+</code> / <code>| plan |</code> table from spark-sql and <code>spark.sql("EXPLAIN …").show(truncate=False)</code>, a shared indent, and the prompt line before the first <code>== … ==</code> header.</li>
          <li>Adaptive plans: <code>AdaptiveSparkPlan isFinalPlan=false</code> before a run, and <code>== Final Plan ==</code> / <code>== Initial Plan ==</code> after one, or <code>== Current Plan ==</code> / <code>== Initial Plan ==</code> while a query is still running. Next to a final or current plan, the initial plan never ran and is not counted.</li>
          <li>Databricks Photon operators (<code>PhotonScan</code>, <code>PhotonFilter</code>, <code>PhotonGroupingAgg</code>, <code>PhotonShuffleExchangeSink/Source</code>, <code>PhotonBroadcastHashJoin</code>). A shuffle is counted once, at its sink.</li>
          <li>Not supported: Spark event logs and Query Profile JSON. Copy the plan text from the SQL tab or Query Profile instead.</li>
        </ul>
      </section>
      <section className="panel">
        <h2>Rules and thresholds</h2>
        <ul className="advice">
          <li><strong>Small side in a sort-merge join</strong>: a join input estimated at 64 MiB or less (from plan statistics, or the optimized logical plan in EXPLAIN COST / EXTENDED). Spark only broadcasts automatically under <code>spark.sql.autoBroadcastJoinThreshold</code> (10 MB default); on Databricks, AQE can convert at runtime up to <code>spark.databricks.adaptive.autoBroadcastJoinThreshold</code> (30 MB default).</li>
          <li><strong>No partition pruning</strong>: the scan is partitioned (output columns that are not in <code>ReadSchema</code>, or a <code>CatalogFileIndex</code>) but <code>PartitionFilters</code> is empty.</li>
          <li><strong>Filter not pushed down</strong>: a predicate directly above a scan wraps the column in a function, CAST or Python UDF and is missing from <code>PushedFilters</code>.</li>
          <li><strong>Shuffled twice</strong>: two Exchanges on one path with the same hash keys, or a user <code>repartition()</code> undone by a later Exchange before any join or aggregate.</li>
          <li><strong>Wide read</strong>: 20 or more columns read from one scan.</li>
          <li><strong>Plan looks truncated</strong>: the text ends inside a line or an open bracket, has logical plans but no <code>== Physical Plan ==</code>, or has an EXPLAIN FORMATTED operator or file scan whose details are missing (a scan without its <code>ReadSchema</code>). Scan findings for the cut-off part are not raised. A cut that falls exactly between two lines of a simple tree cannot be detected.</li>
          <li>Codegen stages are counted per <code>*(n)</code> id, separately inside each subquery.</li>
        </ul>
      </section>
      <section className="panel">
        <h2>Tested against real plans</h2>
        <p>
          The parser runs against Apache Spark's own golden plan files (Apache-2.0, checked 2026-11-16): the approved TPC-DS plans in{' '}
          <a href={`${SPARK}/tpcds-plan-stability/approved-plans-v1_4`}>tpcds-plan-stability</a> (q1, q3, q17, q64, q72) and every EXPLAIN in{' '}
          <a href={`${SPARK}/sql-tests/results`}>explain.sql.out and explain-aqe.sql.out</a>, plus the examples on the{' '}
          <a href="https://spark.apache.org/docs/latest/sql-ref-syntax-qry-explain.html">Spark SQL EXPLAIN reference</a>. The TPC-DS q3 plan ships unedited as the "real" sample and as a test fixture; the other samples are synthetic.
        </p>
      </section>
      <section className="panel">
        <h2>Privacy</h2>
        <p>Plans are parsed in your browser and never uploaded. Table names, paths and literals in the plan stay on your machine.</p>
      </section>
    </Shell>
  )
}
