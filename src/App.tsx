import { RouteApp } from './router.tsx'
import { Landing, MockFrame, MockStat, MockBars, MockList } from './Landing.tsx'
import Tool from './Tool.tsx'

function ProductLanding() {
  return (
    <Landing
      name="PlanLens"
      icon="schema"
      tagline="Spark / Databricks plan analyzer"
      headline="*The Spark UI* serverless forgot"
      support="Paste Dataset.explain() / physical plan text. Flag missed broadcast joins, skew, pandas UDFs, and compare two plans side by side."
      audience="For Databricks and Spark engineers debugging expensive jobs."
      features={[
        {
          icon: 'schema',
          title: 'Plan tree',
          body: 'Navigate physical and logical stages with operator categories and stats attached.',
        },
        {
          icon: 'search_insights',
          title: 'Findings',
          body: 'Catch missed broadcasts, skew reshuffles, pandas UDFs, and partition scans automatically.',
        },
        {
          icon: 'compare_arrows',
          title: 'A/B compare',
          body: 'Diff two plans side by side — before/after a hint, broadcast, or rewrite.',
        },
      ]}
      slides={[
        {
          title: 'Plan summary',
          caption: 'Operators, shuffles, and joins at a glance — shuffle-heavy plans warn early.',
          preview: (
            <MockFrame title="Overview">
              <div className="mock-stats">
                <MockStat label="Operators" value="42" />
                <MockStat label="Shuffles" value="6" tone="warn" />
                <MockStat label="Broadcasts" value="0" tone="bad" />
              </div>
              <MockBars
                items={[
                  { label: 'Shuffle', w: 78, tone: 'warn' },
                  { label: 'Scan', w: 54 },
                  { label: 'Sort', w: 40 },
                ]}
              />
            </MockFrame>
          ),
        },
        {
          title: 'Physical plan tree',
          caption: 'Spot SortMergeJoin where a broadcast should have won.',
          preview: (
            <MockFrame title="Physical plan">
              <div className="mock-tree">
                <div><b>SortMergeJoin</b> Inner · id</div>
                <div>├─ Sort · Exchange hashpartitioning</div>
                <div>│&nbsp;&nbsp;└─ Scan parquet · orders · 12.4 GiB</div>
                <div>└─ Sort · Exchange hashpartitioning</div>
                <div>&nbsp;&nbsp;&nbsp;&nbsp;└─ Scan parquet · dim_customer · 18 MiB</div>
              </div>
            </MockFrame>
          ),
        },
        {
          title: 'Findings',
          caption: 'Actionable issues ranked by severity — missed broadcast first.',
          preview: (
            <MockFrame title="Findings">
              <MockList
                items={[
                  { badge: 'Critical', text: 'Missed broadcast — dim_customer is only 18 MiB', tone: 'bad' },
                  { badge: 'Warning', text: '6 shuffles; consider AQE and join reordering', tone: 'warn' },
                  { badge: 'Info', text: 'No pandas UDFs detected in this plan', tone: 'info' },
                ]}
              />
            </MockFrame>
          ),
        },
      ]}
    />
  )
}

export default function App() {
  return <RouteApp landing={<ProductLanding />} tool={<Tool />} />
}
