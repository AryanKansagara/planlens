import { useDeferredValue, useMemo, useState, type ReactNode } from 'react'
import { Shell } from './Shell.tsx'
import { BackToHome } from './router.tsx'
import {
  analyze,
  diffPlans,
  fmtBytes,
  fmtCount,
  parsePlan,
  summarize,
  type Finding,
  type ParsedPlan,
  type PlanDiff,
  type PlanNode,
  type Severity,
  type Summary,
} from './plan.ts'
import { SAMPLES } from './samples.ts'

type Tab = 'overview' | 'tree' | 'findings' | 'compare'
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'tree', label: 'Plan tree' },
  { id: 'findings', label: 'Findings' },
  { id: 'compare', label: 'A / B compare' },
]

const SEV: Record<Severity, string> = { bad: 'Critical', warn: 'Warning', info: 'Info', good: 'Good' }

function tryParse(text: string): { plan?: ParsedPlan; error?: string } {
  const t = text.trim()
  if (!t) return {}
  try {
    return { plan: parsePlan(t) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

function deltaClass(before: number, after: number) {
  if (after < before) return 'delta-down'
  if (after > before) return 'delta-up'
  return 'delta-same'
}

function joinSummary(s: Summary) {
  const entries = Object.entries(s.joins)
  if (!entries.length) return 'none'
  return entries.map(([k, n]) => `${n}× ${k}`).join(', ')
}

function SummaryStats({ s }: { s: Summary }) {
  const cards: { label: string; value: string }[] = [
    { label: 'Operators', value: fmtCount(s.operators) },
    { label: 'Scans', value: fmtCount(s.scans) },
    { label: 'Shuffles', value: fmtCount(s.shuffles) },
    { label: 'Broadcasts', value: fmtCount(s.broadcasts) },
    { label: 'Sorts', value: fmtCount(s.sorts) },
    { label: 'Codegen stages', value: fmtCount(s.codegenStages) },
    { label: 'AQE', value: s.aqe },
    { label: 'Tables', value: s.tables.length ? String(s.tables.length) : '—' },
  ]
  return (
    <div className="stats">
      {cards.map((c) => (
        <div className="stat" key={c.label}>
          <div className="label">{c.label}</div>
          <div className="value">{c.value}</div>
        </div>
      ))}
    </div>
  )
}

function FindingCard({ f, onJump }: { f: Finding; onJump?: (keys: number[]) => void }) {
  return (
    <article className={`finding ${f.severity}`}>
      <div className="row spread">
        <div className="row">
          <span className={`badge ${f.severity}`}>{SEV[f.severity]}</span>
          <strong>{f.title}</strong>
        </div>
        {f.nodes.length > 0 && onJump && (
          <button className="btn ghost sm" type="button" onClick={() => onJump(f.nodes)}>
            Show in tree
          </button>
        )}
      </div>
      <p className="muted" style={{ margin: '8px 0 0' }}>{f.detail}</p>
      {f.fix && (
        <div className="fix">
          <pre>{f.fix}</pre>
        </div>
      )}
      {f.doc && (
        <p style={{ margin: '8px 0 0' }}>
          <a href={f.doc} target="_blank" rel="noreferrer">Docs</a>
        </p>
      )}
    </article>
  )
}

function PlanTreeNode({
  node,
  depth,
  expanded,
  toggle,
  hot,
  selected,
  onSelect,
}: {
  node: PlanNode
  depth: number
  expanded: Set<number>
  toggle: (key: number) => void
  hot: Set<number>
  selected?: number
  onSelect: (n: PlanNode) => void
}) {
  const hasKids = node.children.length > 0
  const open = expanded.has(node.key)
  const isHot = hot.has(node.key)
  return (
    <li>
      <div
        className={`node${isHot ? ' hot' : ''}${selected === node.key ? ' marked' : ''}`}
        style={{ marginLeft: depth === 0 ? 0 : undefined }}
        onClick={() => onSelect(node)}
        role="treeitem"
        aria-expanded={hasKids ? open : undefined}
      >
        {hasKids ? (
          <button
            className="toggle"
            type="button"
            aria-label={open ? 'Collapse' : 'Expand'}
            onClick={(e) => { e.stopPropagation(); toggle(node.key) }}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="toggle" aria-hidden>·</span>
        )}
        <span className={`name cat-${node.category}`}>{node.name || '(plan)'}</span>
        {node.table && <span className="meta">{node.table}</span>}
        {node.stats && (
          <span className="meta">
            {fmtBytes(node.stats.sizeInBytes)}
            {node.stats.rowCount !== undefined ? ` · ${fmtCount(node.stats.rowCount)} rows` : ''}
          </span>
        )}
        {node.codegen !== undefined && <span className="stage">cg {node.codegen}</span>}
        {node.attrs['Join type'] && <span className="badge info">{node.attrs['Join type']}</span>}
        {node.category !== 'header' && node.category !== 'other' && (
          <span className="badge info" style={{ opacity: 0.7 }}>{node.category}</span>
        )}
      </div>
      {hasKids && open && (
        <ul>
          {node.children.map((c) => (
            <PlanTreeNode
              key={c.key}
              node={c}
              depth={depth + 1}
              expanded={expanded}
              toggle={toggle}
              hot={hot}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

function collectKeys(n: PlanNode, out: number[] = []): number[] {
  out.push(n.key)
  for (const c of n.children) collectKeys(c, out)
  return out
}

function PlanTree({
  root,
  hotKeys,
  selected,
  onSelect,
}: {
  root: PlanNode
  hotKeys: number[]
  selected?: number
  onSelect: (n: PlanNode) => void
}) {
  const allKeys = useMemo(() => collectKeys(root), [root])
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(allKeys))
  const hot = useMemo(() => new Set(hotKeys), [hotKeys])

  // Reset expansion when a new root is loaded.
  const [prevRoot, setPrevRoot] = useState(root)
  if (root !== prevRoot) {
    setPrevRoot(root)
    setExpanded(new Set(collectKeys(root)))
  }

  const toggle = (key: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <button className="btn ghost sm" type="button" onClick={() => setExpanded(new Set(allKeys))}>Expand all</button>
        <button className="btn ghost sm" type="button" onClick={() => setExpanded(new Set())}>Collapse all</button>
      </div>
      <ul className="tree" role="tree">
        <PlanTreeNode
          node={root}
          depth={0}
          expanded={expanded}
          toggle={toggle}
          hot={hot}
          selected={selected}
          onSelect={onSelect}
        />
      </ul>
    </div>
  )
}

function NodeDetail({ node }: { node: PlanNode }) {
  const attrs = Object.entries(node.attrs)
  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <div className="head-row">
        <h3>{node.name}</h3>
        <span className="badge info">{node.category}</span>
      </div>
      {node.table && <p className="muted" style={{ margin: '0 0 8px' }}>Table: <code>{node.table}</code></p>}
      {node.text && <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: '0 0 8px', fontSize: 12 }}>{node.text}</pre>}
      {attrs.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Attribute</th><th>Value</th></tr>
            </thead>
            <tbody>
              {attrs.map(([k, v]) => (
                <tr key={k}><td className="mono">{k}</td><td className="mono">{v}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ComparePanel({ diff }: { diff: PlanDiff }) {
  return (
    <div className="grid" style={{ gap: 20 }}>
      <div>
        <h3>Stat deltas</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Metric</th><th>Plan A</th><th>Plan B</th><th>Δ</th></tr>
            </thead>
            <tbody>
              {diff.stats.map((s) => (
                <tr key={s.label}>
                  <td>{s.label}</td>
                  <td className="mono">{s.before}</td>
                  <td className="mono">{s.after}</td>
                  <td className={`mono ${deltaClass(s.before, s.after)}`}>
                    {s.after - s.before > 0 ? '+' : ''}{s.after - s.before}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {diff.operators.length > 0 && (
        <div>
          <h3>Operator changes</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Operator</th><th>A</th><th>B</th></tr>
              </thead>
              <tbody>
                {diff.operators.map((o) => (
                  <tr key={o.op}>
                    <td className="mono">{o.op}</td>
                    <td className="mono">{o.before}</td>
                    <td className={`mono ${deltaClass(o.before, o.after)}`}>{o.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="grid cols-2">
        <div>
          <h3>Resolved in B <span className="badge good">{diff.resolved.length}</span></h3>
          {diff.resolved.length === 0 && <p className="muted">No findings cleared.</p>}
          {diff.resolved.map((f) => <FindingCard key={`r-${f.id}`} f={f} />)}
        </div>
        <div>
          <h3>Introduced in B <span className="badge warn">{diff.introduced.length}</span></h3>
          {diff.introduced.length === 0 && <p className="muted">No new findings.</p>}
          {diff.introduced.map((f) => <FindingCard key={`i-${f.id}`} f={f} />)}
        </div>
      </div>
    </div>
  )
}

function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <div className="head-row">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

export default function Tool() {
  const [textA, setTextA] = useState('')
  const [textB, setTextB] = useState('')
  const [tab, setTab] = useState<Tab>('overview')
  const [hotKeys, setHotKeys] = useState<number[]>([])
  const [selected, setSelected] = useState<PlanNode>()
  const [sampleId, setSampleId] = useState<string>()

  const deferredA = useDeferredValue(textA)
  const deferredB = useDeferredValue(textB)

  const parsedA = useMemo(() => tryParse(deferredA), [deferredA])
  const parsedB = useMemo(() => tryParse(deferredB), [deferredB])

  const plan = parsedA.plan
  const findings = useMemo(() => (plan ? analyze(plan) : []), [plan])
  const summary = useMemo(() => (plan ? summarize(plan.physical) : undefined), [plan])
  const diff = useMemo(
    () => (parsedA.plan && parsedB.plan ? diffPlans(parsedA.plan, parsedB.plan) : undefined),
    [parsedA.plan, parsedB.plan],
  )

  const loadSample = (id: string, target: 'a' | 'b' = 'a') => {
    const s = SAMPLES.find((x) => x.id === id)
    if (!s) return
    if (target === 'a') {
      setTextA(s.text)
      setSampleId(id)
      setSelected(undefined)
      setHotKeys([])
      setTab('overview')
    } else {
      setTextB(s.text)
      setTab('compare')
    }
  }

  const jumpToNodes = (keys: number[]) => {
    setHotKeys(keys)
    setTab('tree')
  }

  const counts = useMemo(() => {
    const c = { bad: 0, warn: 0, info: 0, good: 0 }
    for (const f of findings) c[f.severity]++
    return c
  }, [findings])

  return (
    <Shell name="PlanLens" tagline="Spark / Databricks plan analyzer" icon="schema">
      <BackToHome />
      <section className="hero">
        <h1>See what your Spark plan is really doing</h1>
        <p>
          Paste <code>df.explain()</code>, <code>Dataset.explain</code>, or <code>EXPLAIN [EXTENDED|COST|FORMATTED]</code> output.
          PlanLens parses the tree, flags shuffle and scan issues, and can diff two plans side by side.
        </p>
        <div className="privacy">
          <span className="badge good">Private</span>
          Runs entirely in your browser — plans never leave your machine.
        </div>
      </section>

      <section className="panel">
        <div className="head-row">
          <h2>Plan input</h2>
          <div className="row">
            {textA && (
              <button className="btn ghost sm" type="button" onClick={() => { setTextA(''); setSampleId(undefined); setSelected(undefined); setHotKeys([]) }}>
                Clear A
              </button>
            )}
            {textB && (
              <button className="btn ghost sm" type="button" onClick={() => setTextB('')}>
                Clear B
              </button>
            )}
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>Samples</div>
          <div className="row">
            {SAMPLES.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`btn sm ${sampleId === s.id ? 'tonal' : 'ghost'}`}
                title={s.blurb}
                onClick={() => loadSample(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
          {sampleId && (
            <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>
              {SAMPLES.find((s) => s.id === sampleId)?.blurb}
              {sampleId === 'missed-broadcast' && (
                <>
                  {' '}
                  <button className="btn ghost sm" type="button" onClick={() => loadSample('broadcast-fixed', 'b')}>
                    Load fixed plan as B
                  </button>
                </>
              )}
            </p>
          )}
        </div>

        <div className="grid cols-2">
          <label className="field" style={{ marginTop: 0 }}>
            <span>Plan A</span>
            <textarea
              value={textA}
              onChange={(e) => { setTextA(e.target.value); setSampleId(undefined) }}
              spellCheck={false}
              placeholder={'== Physical Plan ==\n*(1) Scan parquet ...\n'}
              aria-label="Plan A text"
            />
            {parsedA.error && <span className="badge bad">{parsedA.error}</span>}
            {plan && !parsedA.error && (
              <span className="muted" style={{ fontSize: 13 }}>
                Parsed as <strong>{plan.mode}</strong> · {plan.sections.length} section{plan.sections.length === 1 ? '' : 's'}
              </span>
            )}
          </label>
          <label className="field" style={{ marginTop: 0 }}>
            <span>Plan B <span className="muted">(optional — for compare)</span></span>
            <textarea
              value={textB}
              onChange={(e) => setTextB(e.target.value)}
              spellCheck={false}
              placeholder="Paste a second plan to diff against A…"
              aria-label="Plan B text"
            />
            {parsedB.error && <span className="badge bad">{parsedB.error}</span>}
            {parsedB.plan && !parsedB.error && (
              <span className="muted" style={{ fontSize: 13 }}>
                Parsed as <strong>{parsedB.plan.mode}</strong>
                {' · '}
                <button className="btn ghost sm" type="button" onClick={() => setTab('compare')}>Open compare</button>
              </span>
            )}
          </label>
        </div>
      </section>

      {plan && summary && (
        <>
          <div className="tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                disabled={t.id === 'compare' && !diff}
              >
                {t.label}
                {t.id === 'findings' && findings.length > 0 ? ` (${findings.length})` : ''}
              </button>
            ))}
          </div>

          {tab === 'overview' && (
            <>
              <Panel title="Summary">
                <SummaryStats s={summary} />
                <p className="muted" style={{ marginTop: 14, fontSize: 13.5 }}>
                  Joins: {joinSummary(summary)}
                  {summary.tables.length > 0 && (
                    <> · Tables: {summary.tables.map((t) => t.split('.').pop()).join(', ')}</>
                  )}
                </p>
              </Panel>
              <Panel
                title="Top findings"
                action={
                  <button className="btn ghost sm" type="button" onClick={() => setTab('findings')}>
                    All findings
                  </button>
                }
              >
                <div className="row" style={{ marginBottom: 8 }}>
                  {(Object.keys(counts) as Severity[]).map((sev) =>
                    counts[sev] ? (
                      <span key={sev} className={`badge ${sev}`}>{counts[sev]} {SEV[sev].toLowerCase()}</span>
                    ) : null,
                  )}
                </div>
                {findings.filter((f) => f.severity !== 'good').slice(0, 4).map((f) => (
                  <FindingCard key={f.id} f={f} onJump={jumpToNodes} />
                ))}
                {findings.filter((f) => f.severity !== 'good').length === 0 && (
                  <p className="muted">No issues flagged — see good signals under Findings.</p>
                )}
              </Panel>
            </>
          )}

          {tab === 'tree' && (
            <Panel title="Interactive plan tree">
              <PlanTree
                root={plan.physical}
                hotKeys={hotKeys}
                selected={selected?.key}
                onSelect={setSelected}
              />
              {selected && <NodeDetail node={selected} />}
            </Panel>
          )}

          {tab === 'findings' && (
            <Panel title="Findings">
              {findings.length === 0 && <p className="muted">Nothing flagged for this plan.</p>}
              {findings.map((f) => (
                <FindingCard key={f.id} f={f} onJump={jumpToNodes} />
              ))}
            </Panel>
          )}

          {tab === 'compare' && diff && (
            <Panel title="Plan A → Plan B">
              <ComparePanel diff={diff} />
            </Panel>
          )}
        </>
      )}

      {!plan && !parsedA.error && (
        <section className="panel">
          <p className="muted" style={{ margin: 0 }}>
            Paste a plan or pick a sample to get started. Analysis stays on this device.
          </p>
        </section>
      )}
    </Shell>
  )
}
