// Parsing and diagnosis of Spark physical/logical plan text (EXPLAIN / Dataset.explain output).

export type Category = 'scan' | 'filter' | 'join' | 'exchange' | 'broadcast' | 'aggregate' | 'sort' | 'python' | 'header' | 'other'
export type Severity = 'bad' | 'warn' | 'info' | 'good'

export interface Stats { sizeInBytes: number; rowCount?: number }
export interface Metric { name: string; type: string; value: number }
export interface PlanNode {
  key: number
  name: string
  text: string
  category: Category
  attrs: Record<string, string>
  children: PlanNode[]
  opId?: number
  codegen?: number
  table?: string
  stats?: Stats
  metrics?: Metric[]
}
export interface PlanSection { title: string; root: PlanNode }
export interface ParsedPlan { mode: 'simple' | 'extended' | 'cost' | 'formatted'; sections: PlanSection[]; physical: PlanNode; logical?: PlanNode }
export interface Finding {
  id: string
  severity: Severity
  title: string
  detail: string
  fix?: string
  doc?: string
  nodes: number[]
}

const DOCS = {
  hints: 'https://spark.apache.org/docs/latest/sql-ref-syntax-qry-select-hints.html',
  tuning: 'https://spark.apache.org/docs/latest/sql-performance-tuning.html',
  aqe: 'https://docs.databricks.com/aws/en/optimizations/aqe',
  skipping: 'https://docs.databricks.com/aws/en/delta/data-skipping',
  pandas: 'https://docs.databricks.com/aws/en/udf/pandas',
  skew: 'https://docs.databricks.com/aws/en/optimizations/skew-join',
}

// ---------- small string helpers ----------

const OPEN = '([{', CLOSE = ')]}'

/** Index of `needle` in `s` outside any (), [] or {} nesting, or -1. */
function topIndex(s: string, needle: string, from = 0): number {
  let depth = 0
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (OPEN.includes(c)) depth++
    else if (CLOSE.includes(c)) depth--
    else if (depth === 0 && s.startsWith(needle, i)) return i
  }
  return -1
}

/** Split on commas at nesting depth 0. */
export function splitTop(s: string, sep = ','): string[] {
  const out: string[] = []
  let start = 0
  for (let i = topIndex(s, sep); i >= 0; i = topIndex(s, sep, start)) {
    out.push(s.slice(start, i).trim())
    start = i + sep.length
  }
  out.push(s.slice(start).trim())
  return out.filter(Boolean)
}

/** Index of the bracket closing the one at `open`. */
function closing(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (OPEN.includes(s[i])) depth++
    else if (CLOSE.includes(s[i]) && --depth === 0) return i
  }
  return -1
}

/** "[a, b]" -> ["a", "b"]; tolerates values abbreviated with "..." by Spark. */
export function listOf(v?: string): string[] {
  const t = v?.trim()
  if (!t) return []
  if (!t.startsWith('[')) return [t]
  return splitTop(t.slice(1, t.endsWith(']') ? -1 : undefined))
}

const stripId = (a: string) => a.trim().replace(/#\d+L?$/, '')

/** Column names in a ReadSchema struct<...> string. */
export function schemaColumns(schema?: string): { cols: string[]; truncated: boolean } {
  if (!schema) return { cols: [], truncated: false }
  const truncated = schema.endsWith('...')
  let body = schema.replace(/^struct</, '').replace(/\.\.\.$/, '')
  if (!truncated) body = body.replace(/>$/, '')
  const cols: string[] = []
  let depth = 0, start = 0
  for (let i = 0; i <= body.length; i++) {
    const c = body[i]
    if (c === '<' || c === '(') depth++
    else if (c === '>' || c === ')') depth--
    else if ((c === ',' && depth === 0) || i === body.length) {
      const name = body.slice(start, i).split(':')[0].trim()
      if (name) cols.push(name.replace(/`/g, ''))
      start = i + 1
    }
  }
  if (truncated) cols.pop() // last entry is cut mid-way
  return { cols, truncated }
}

/** Output attribute list -> names and total count (handles "... 5 more fields"). */
export function outputColumns(v?: string): { cols: string[]; count: number } {
  let count = 0
  const cols: string[] = []
  for (const item of listOf(v)) {
    const more = /^\.\.\. (\d+) more fields?$/.exec(item)
    if (more) count += +more[1]
    else { cols.push(stripId(item)); count++ }
  }
  return { cols, count }
}

const UNITS: Record<string, number> = { B: 1, KiB: 2 ** 10, MiB: 2 ** 20, GiB: 2 ** 30, TiB: 2 ** 40, PiB: 2 ** 50, EiB: 2 ** 60 }

export function parseStats(s: string): Stats | undefined {
  const m = /Statistics\(sizeInBytes=([\d.E+-]+) (\w+)(?:, rowCount=([\d.E+-]+))?/.exec(s)
  if (!m || !(m[2] in UNITS)) return undefined
  return { sizeInBytes: Number(m[1]) * UNITS[m[2]], rowCount: m[3] === undefined ? undefined : Number(m[3]) }
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '-'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`
  return `${(ms / 3_600_000).toFixed(1)} h`
}

export function fmtCount(n: number): string {
  if (n < 1000) return String(n)
  const units = ['K', 'M', 'B', 'T']
  let i = -1
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++ }
  return `${n.toFixed(n < 10 ? 2 : 1)}${units[i]}`
}

export function fmtMetric(m: Metric): string {
  if (m.type === 'size') return fmtBytes(m.value)
  if (m.type === 'timing') return fmtMs(m.value)
  if (m.type === 'nsTiming') return fmtMs(m.value / 1e6)
  return m.value.toLocaleString('en-US')
}

// ---------- node construction ----------

const JOIN_TYPE = /^(Inner|Cross|LeftOuter|RightOuter|FullOuter|LeftSemi|LeftAnti|LeftSingle|ExistenceJoin\(.*\))$/

export function categorize(name: string): Category {
  if (/EvalPython|Python|Pandas|MapInArrow|ArrowEval/.test(name)) return 'python'
  if (/Join|CartesianProduct/.test(name)) return 'join'
  if (/BroadcastExchange|BroadcastQueryStage/.test(name)) return 'broadcast'
  if (/Exchange|Shuffle|AQEShuffleRead|CustomShuffleReader/.test(name)) return 'exchange'
  if (/Scan|^Range$|^Relation$|^LogicalRelation$|RDD|^LocalRelation$/.test(name)) return 'scan'
  if (/Aggregate|GroupingAgg|^Expand$/.test(name)) return 'aggregate'
  if (/Sort|TakeOrdered|TopK/.test(name)) return 'sort'
  if (/^(Photon)?(Filter|Project)$|ColumnarToRow|RowToColumnar|InputAdapter/.test(name)) return 'filter'
  return 'other'
}

type Ctx = { next: number }

/** Build a node from one operator string as Spark prints it in tree (simple) mode. */
export function buildNode(content: string, ctx: Ctx, formatted = false): PlanNode {
  let s = content.trim()
  const node: PlanNode = { key: ctx.next++, name: '', text: s, category: 'other', attrs: {}, children: [] }
  const header = /^== (.+) ==$/.exec(s)
  if (header) return { ...node, name: header[1], category: 'header' }

  const cg = /^\*\((\d+)\) /.exec(s)
  if (cg) { node.codegen = +cg[1]; s = s.slice(cg[0].length) }
  else if (s.startsWith('* ')) { node.codegen = 0; s = s.slice(2) }

  const statIdx = s.search(/,? ?Statistics\(sizeInBytes=/)
  if (statIdx >= 0) { node.stats = parseStats(s.slice(statIdx)); s = s.slice(0, statIdx) }
  if (formatted) {
    const id = / \((\d+)\)$/.exec(s)
    if (id) { node.opId = +id[1]; s = s.slice(0, id.index) }
  }
  node.text = s

  const first = /^[A-Za-z_][\w$]*/.exec(s)?.[0] ?? s
  const scan = /^(\w*Scan) ([A-Za-z]\w*)\b/.exec(s)
  node.name = scan ? `${scan[1]} ${scan[2]}` : first
  if (/^(BatchEvalPython|ArrowEvalPython)$/.test(first)) node.name = first
  node.category = categorize(node.name)
  const args = s.slice(node.name.length).trim()

  if (scan) {
    const t = /^(\S+?)(?:\[|$)/.exec(args)
    const bracket = args.indexOf('[')
    if (t && !t[1].includes(':') && t[1] !== '[') node.table = t[1]
    if (!formatted && bracket >= 0) {
      const end = closing(args, bracket)
      node.attrs.Output = args.slice(bracket, end + 1)
      for (const kv of args.slice(end + 1).trim().split(/, (?=[A-Z][A-Za-z]*: )/)) {
        const i = kv.indexOf(': ')
        if (i > 0) node.attrs[kv.slice(0, i)] = kv.slice(i + 2)
      }
    }
  } else if (first === 'Relation') {
    const r = /^Relation ([^\s[]+)\[/.exec(s)
    if (r) node.table = r[1]
    node.attrs.Arguments = args
  } else if (!formatted && args) {
    if (node.category === 'join') parseJoinArgs(args, node.attrs)
    else if (/Aggregate$/.test(first) && args.startsWith('(')) {
      for (const kv of splitTop(args.slice(1, -1))) {
        const i = kv.indexOf('=')
        if (i > 0) node.attrs[kv[0].toUpperCase() + kv.slice(1, i)] = kv.slice(i + 1)
      }
    } else if (/Filter$/.test(first)) node.attrs.Condition = args
    else if (/Project$/.test(first)) node.attrs.Output = args
    else node.attrs.Arguments = args
  } else if (formatted && node.category === 'join') {
    const b = /Build(Left|Right)/.exec(args)
    if (b) node.attrs['Build side'] = b[0]
  }
  return node
}

function parseJoinArgs(args: string, attrs: Record<string, string>) {
  let keys = 0
  for (const p of splitTop(args)) {
    if (p.startsWith('[') && keys < 2) attrs[keys++ === 0 ? 'Left keys' : 'Right keys'] = p
    else if (JOIN_TYPE.test(p)) attrs['Join type'] = p
    else if (/^Build(Left|Right)$/.test(p)) attrs['Build side'] = p
    else if (p !== 'true' && p !== 'false') attrs['Join condition'] = p
  }
}

/** Fill in derived attributes once all details are known. */
function finish(n: PlanNode) {
  if (n.category === 'exchange' || n.category === 'broadcast') {
    const a = n.attrs.Arguments ?? ''
    if (!n.attrs.Partitioning && /^Exchange|ShuffleExchange/.test(n.name) && a) n.attrs.Partitioning = splitTop(a)[0]
  }
  if (n.category === 'join' && !n.attrs['Join type'] && n.attrs.Arguments) parseJoinArgs(n.attrs.Arguments, n.attrs)
  if (n.category === 'scan' && !n.table && n.attrs.Location) n.table = /\[([^\],]+)/.exec(n.attrs.Location)?.[1]
  n.children.forEach(finish)
}

// ---------- tree parsing ----------

function parseTree(lines: string[], ctx: Ctx, formatted = false): PlanNode | undefined {
  const stack: { col: number; node: PlanNode }[] = []
  const roots: PlanNode[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    const m = /^((?: {3}|: {2})*)([+:]- )?(.*)$/.exec(line.replace(/\s+$/, ''))!
    const leading = m[1].length + /^ */.exec(m[3])![0].length
    const col = leading + (m[2] ? 3 : 1) // marker-less lines nest under a header at the same column
    const node = buildNode(m[3], ctx, formatted)
    while (stack.length && stack[stack.length - 1].col >= col) stack.pop()
    if (stack.length) stack[stack.length - 1].node.children.push(node)
    else roots.push(node)
    stack.push({ col: m[2] ? col : leading, node })
  }
  if (roots.length <= 1) return roots[0]
  return { key: ctx.next++, name: 'Plan', text: '', category: 'header', attrs: {}, children: roots }
}

const BLOCK = /^\((\d+)\) (.+?)(?: \[codegen id : (\d+)\])?$/
const ATTR = /^([A-Za-z][\w ]*?)(?: \[\d+\])? ?: (.*)$/

function parseFormatted(lines: string[], ctx: Ctx): PlanNode | undefined {
  const firstBlank = lines.findIndex((l) => !l.trim())
  const root = parseTree(firstBlank < 0 ? lines : lines.slice(0, firstBlank), ctx, true)
  if (!root) return undefined
  const details = new Map<number, { codegen?: number; attrs: Record<string, string> }>()
  const subqueries: { host: number; title: string; expr: string; lines: string[] }[] = []
  let block: Record<string, string> | undefined, last = ''
  let sub: string[] | undefined
  for (const line of firstBlank < 0 ? [] : lines.slice(firstBlank)) {
    if (!line.trim()) { block = undefined; sub = undefined; continue }
    const b = BLOCK.exec(line), q = /^Subquery:(\d+) Hosting operator id = (\d+) Hosting Expression = (.*)$/.exec(line)
    if (b && !sub) {
      block = {}
      last = ''
      const reuse = /\[Reuses operator id: (\d+)\]/.exec(b[2])
      if (reuse) block['Reuses operator id'] = reuse[1]
      details.set(+b[1], { codegen: b[3] === undefined ? undefined : +b[3], attrs: block })
    } else if (q) {
      sub = []
      subqueries.push({ host: +q[2], title: `Subquery:${q[1]}`, expr: q[3], lines: sub })
    } else if (/^=====/.test(line) || /^Subplan:\d+/.test(line)) {
      block = undefined
      sub = undefined
    } else if (sub) sub.push(line)
    else if (block) {
      const a = ATTR.exec(line)
      if (a) { block[a[1]] = a[2]; last = a[1] }
      else if (last) block[last] += '\n' + line
      else block.Info = line
    }
  }
  const byId = new Map<number, PlanNode>()
  const merge = (n: PlanNode) => {
    const d = n.opId === undefined ? undefined : details.get(n.opId)
    if (d) { Object.assign(n.attrs, d.attrs); if (d.codegen !== undefined) n.codegen = d.codegen }
    if (n.opId !== undefined && !byId.has(n.opId)) byId.set(n.opId, n)
    n.children.forEach(merge)
  }
  merge(root)
  for (const q of subqueries) {
    const tree = parseTree(q.lines, ctx, true)
    const host = byId.get(q.host)
    if (!tree || !host) continue
    merge(tree)
    host.children.push({ key: ctx.next++, name: q.title, text: q.expr, category: 'header', attrs: { 'Hosting expression': q.expr }, children: [tree] })
  }
  return root
}

export function parsePlan(input: string): ParsedPlan {
  const lines = input.replace(/\r\n?/g, '\n').split('\n')
  const raw: { title: string; lines: string[] }[] = []
  let cur: { title: string; lines: string[] } = { title: 'Physical Plan', lines: [] }
  let sawHeader = false
  for (const l of lines) {
    const m = /^== (.+) ==\s*$/.exec(l)
    if (m) {
      if (sawHeader || !lines.some((x) => /^== .+ ==\s*$/.test(x))) raw.push(cur)
      sawHeader = true
      cur = { title: m[1], lines: [] }
    } else cur.lines.push(l)
  }
  raw.push(cur)

  const ctx: Ctx = { next: 0 }
  const sections: PlanSection[] = []
  let formatted = false
  for (const r of raw.filter((x) => x.lines.some((l) => l.trim()))) {
    let body = r.lines.filter((l, i) => i > 0 || l.trim())
    while (body.length && !body[0].trim()) body = body.slice(1)
    // The analyzed plan is preceded by its output schema line, e.g. "sum(DISTINCT val): bigint".
    if (r.title === 'Analyzed Logical Plan' && body.length > 1 && !/^[+:]- /.test(body[1].trim())) body = body.slice(1)
    const isFormatted = /Physical Plan/.test(r.title) && body.some((l) => BLOCK.test(l)) && / \(\d+\)\s*$/.test(body[0])
    formatted ||= isFormatted
    const root = isFormatted ? parseFormatted(body, ctx) : parseTree(body, ctx)
    if (root) { finish(root); sections.push({ title: r.title, root }) }
  }
  const physical = (sections.find((s) => s.title === 'Physical Plan') ?? sections[0])?.root
  if (!physical) throw new Error('No plan found. Paste the output of df.explain(...), EXPLAIN [EXTENDED|FORMATTED|COST] <query>, or a Spark event log.')
  let known = 0
  walk(physical, (n) => { if (n.category !== 'other' && n.category !== 'header') known++ })
  if (!known && !/[+:]- /.test(input)) throw new Error('This does not look like a Spark plan: no known operators (Scan, Filter, Join, Exchange, ...) were found.')
  const logical = sections.find((s) => s.title === 'Optimized Logical Plan')?.root
  const hasStats = logical !== undefined && JSON.stringify(sections).includes('"sizeInBytes"')
  const mode = formatted ? 'formatted' : sections.some((s) => s.title === 'Parsed Logical Plan') ? 'extended' : hasStats ? 'cost' : 'simple'
  return { mode, sections, physical, logical }
}

// ---------- analysis ----------

/** Pre-order walk. Skips the "Initial Plan" branch of an AQE plan, which never ran. */
export function walk(n: PlanNode, fn: (n: PlanNode, parent?: PlanNode) => void, parent?: PlanNode) {
  if (n.category === 'header' && n.name === 'Initial Plan') return
  fn(n, parent)
  for (const c of n.children) walk(c, fn, n)
}

function all(root: PlanNode, pred: (n: PlanNode) => boolean): PlanNode[] {
  const out: PlanNode[] = []
  walk(root, (n) => { if (pred(n)) out.push(n) })
  return out
}

const isShuffle = (n: PlanNode) => n.category === 'exchange' && /Exchange/.test(n.name) && !/Reused|Source/.test(n.name)
const isBroadcast = (n: PlanNode) => n.category === 'broadcast' && /BroadcastExchange/.test(n.name)
const isScan = (n: PlanNode) => /^(File)?Scan [a-z]/.test(n.name) && n.table !== undefined

export interface Summary {
  operators: number
  scans: number
  tables: string[]
  shuffles: number
  broadcasts: number
  sorts: number
  joins: Record<string, number>
  codegenStages: number
  aqe: 'off' | 'initial' | 'final'
}

export function summarize(root: PlanNode): Summary {
  const s: Summary = { operators: 0, scans: 0, tables: [], shuffles: 0, broadcasts: 0, sorts: 0, joins: {}, codegenStages: 0, aqe: 'off' }
  const stages = new Set<string>()
  let aqeSeen = false
  const visit = (n: PlanNode, scope: number) => {
    if (n.category === 'header') {
      if (n.name === 'Initial Plan') return
      scope = n.key
    } else if (n.name !== 'WholeStageCodegen' && n.name !== 'InputAdapter') s.operators++
    if (n.category === 'scan') { s.scans++; if (n.table && !s.tables.includes(n.table)) s.tables.push(n.table) }
    if (isShuffle(n)) s.shuffles++
    if (isBroadcast(n)) s.broadcasts++
    if (n.name === 'Sort') s.sorts++
    if (n.category === 'join') {
      const k = [n.name, n.attrs['Join type']].filter(Boolean).join(' ')
      s.joins[k] = (s.joins[k] ?? 0) + 1
    }
    if (/^Subquery|SubqueryBroadcast/.test(n.name)) scope = n.key
    if (n.codegen) stages.add(`${scope}:${n.codegen}`)
    if (n.name === 'AdaptiveSparkPlan' && !aqeSeen) {
      aqeSeen = true
      s.aqe = /isFinalPlan=true/.test(n.text + (n.attrs.Arguments ?? '')) ? 'final' : 'initial'
    }
    n.children.forEach((c) => visit(c, scope))
  }
  visit(root, -1)
  s.codegenStages = stages.size
  return s
}

/** Split a Spark condition string into its top-level AND conjuncts. */
export function conjuncts(e: string): string[] {
  e = e.trim()
  let i = topIndex(e, ' AND ')
  if (i < 0 && e.startsWith('(') && closing(e, 0) === e.length - 1) {
    const inner = e.slice(1, -1)
    i = topIndex(inner, ' AND ')
    if (i >= 0) return [...conjuncts(inner.slice(0, i)), ...conjuncts(inner.slice(i + 5))]
    return [e]
  }
  return i < 0 ? [e] : [...conjuncts(e.slice(0, i)), ...conjuncts(e.slice(i + 5))]
}

const shortName = (t: string) => t.split('.').pop()!
const colOf = (s: string) => /(\w+)#\d+/.exec(s)?.[1] ?? 'col'

function tablesUnder(n: PlanNode): string[] {
  return [...new Set(all(n, (x) => x.category === 'scan' && !!x.table).map((x) => x.table!))].sort()
}

/** Size estimate of a join input: runtime/plan stats on the side, else the optimized logical plan. */
function sideSize(side: PlanNode, logical?: PlanNode): number | undefined {
  const withStats = all(side, (x) => !!x.stats)[0]
  if (withStats) return withStats.stats!.sizeInBytes
  if (!logical) return undefined
  const want = tablesUnder(side).join('|')
  if (!want) return undefined
  return all(logical, (x) => !!x.stats && x.category !== 'header' && tablesUnder(x).join('|') === want)[0]?.stats?.sizeInBytes
}

const SMALL_SIDE = 64 * 2 ** 20
const WIDE_READ = 20

export function analyze(plan: { physical: PlanNode; logical?: PlanNode }): Finding[] {
  const root = plan.physical
  const out: Finding[] = []
  const add = (f: Finding) => { if (!out.some((o) => o.id === f.id)) out.push(f) }
  const summary = summarize(root)

  // Cartesian / nested loop joins
  for (const j of all(root, (n) => /^(CartesianProduct|BroadcastNestedLoopJoin)$/.test(n.name))) {
    add({
      id: `nlj:${j.key}`, severity: 'bad', nodes: [j.key],
      title: `${j.name}${j.attrs['Join type'] ? ` (${j.attrs['Join type']})` : ''}: rows are compared pairwise`,
      detail: `${j.name} evaluates the join condition for every pair of rows (O(n x m)). This happens when the join has no equality predicate, e.g. a missing ON clause, an OR across columns, or a range/inequality join${j.attrs['Join condition'] ? `. Condition: ${j.attrs['Join condition']}` : ''}.`,
      fix: `-- Give the join an equi-join key so Spark can hash or sort-merge it\nSELECT ... FROM a JOIN b ON a.id = b.id AND a.ts BETWEEN b.start AND b.end\n\n# For range joins, bucket the range into an equality key first\na.join(b, (a.bucket == b.bucket) & a.ts.between(b.start, b.end))`,
      doc: DOCS.hints,
    })
  }

  // Sort-merge joins with a small side, and the cost of their sorts
  for (const j of all(root, (n) => /SortMergeJoin$/.test(n.name))) {
    const [l, r] = j.children
    if (!l || !r) continue
    const ls = sideSize(l, plan.logical), rs = sideSize(r, plan.logical)
    const small = [ls === undefined ? undefined : { side: l, size: ls }, rs === undefined ? undefined : { side: r, size: rs }]
      .filter((x): x is { side: PlanNode; size: number } => !!x && x.size <= SMALL_SIDE)
      .sort((a, b) => a.size - b.size)[0]
    if (small) {
      const t = shortName(tablesUnder(small.side)[0] ?? 'dim')
      add({
        id: `smj-small:${j.key}`, severity: 'warn', nodes: [j.key, ...small.side.children.map((c) => c.key)],
        title: `SortMergeJoin with a small side (~${fmtBytes(small.size)}, ${t}): broadcast it`,
        detail: `One input is estimated at ${fmtBytes(small.size)}, yet both sides are shuffled and sorted. A broadcast hash join ships the small side to every executor and avoids shuffling the large side entirely. Spark only broadcasts automatically below spark.sql.autoBroadcastJoinThreshold (10 MB by default; -1 disables it) and when statistics are fresh. AQE can still switch to a broadcast join at runtime, but only after the shuffle has been written.`,
        fix: `-- SQL (works on serverless)\nSELECT /*+ BROADCAST(${t}) */ ...\nFROM fact JOIN ${t} ON ...\n\n# PySpark\nfrom pyspark.sql.functions import broadcast\nfact.join(broadcast(${t}_df), "key")\n\n-- Classic compute / OSS: raise the threshold or refresh stats\nSET spark.sql.autoBroadcastJoinThreshold = 64MB;\nANALYZE TABLE ${t} COMPUTE STATISTICS;`,
        doc: DOCS.hints,
      })
    }
    const sorts = j.children.filter((c) => c.name === 'Sort')
    if (sorts.length) {
      add({
        id: `smj-sort:${j.key}`, severity: 'info', nodes: sorts.map((s) => s.key),
        title: `SortMergeJoin sorts ${sorts.length === 2 ? 'both inputs' : 'its input'} before joining`,
        detail: `Each side is hash-partitioned and then fully sorted on the join keys (${j.attrs['Left keys'] ?? 'keys'}). For large inputs the sort can spill to disk. If one side fits in memory per partition, a shuffled hash join skips the sort; if one side is small, a broadcast join skips the shuffle too.`,
        fix: `SELECT /*+ SHUFFLE_HASH(smaller_table) */ ...\n-- or\nSELECT /*+ BROADCAST(small_table) */ ...`,
        doc: DOCS.hints,
      })
    }
  }

  // Scans: pushdown, partition pruning, column width
  const pushedTables: string[] = []
  const prunedTables: string[] = []
  for (const s of all(root, isScan)) {
    const t = s.table!
    const pushed = listOf(s.attrs.PushedFilters).filter((p) => !/^IsNotNull\(/.test(p))
    if (pushed.length) pushedTables.push(shortName(t))
    const pf = listOf(s.attrs.PartitionFilters)
    const { cols: readCols, truncated } = schemaColumns(s.attrs.ReadSchema)
    const out = outputColumns(s.attrs.Output)
    const partCols = truncated ? [] : out.cols.filter((c) => !readCols.includes(c))
    const partitioned = /^CatalogFileIndex/.test(s.attrs.Location ?? '') || partCols.length > 0
    if (pf.length) prunedTables.push(shortName(t))
    else if (partitioned) {
      const pc = partCols[0] ?? 'partition_col'
      add({
        id: `no-prune:${t}`, severity: 'warn', nodes: [s.key],
        title: `No partition pruning on ${shortName(t)}`,
        detail: `${t} is partitioned${partCols.length ? ` by ${partCols.join(', ')}` : ' (CatalogFileIndex)'}, but PartitionFilters is empty, so every partition is listed and read. Partition pruning only happens when the query filters directly on the partition column(s).`,
        fix: `-- Filter on the partition column itself, with literals of the same type\nSELECT ... FROM ${t}\nWHERE ${pc} >= DATE'2024-01-01' AND ${pc} < DATE'2024-02-01'\n\n# PySpark\ndf.filter((F.col("${pc}") >= "2024-01-01") & (F.col("${pc}") < "2024-02-01"))`,
        doc: DOCS.skipping,
      })
    }
    const width = Math.max(out.count, readCols.length)
    if (width >= WIDE_READ) {
      add({
        id: `wide:${t}`, severity: 'info', nodes: [s.key],
        title: `Wide read: ${width}${truncated ? '+' : ''} columns from ${shortName(t)}`,
        detail: `The scan reads ${width}${truncated ? '+' : ''} columns. Columnar formats (Parquet/Delta) only read the columns requested, so a SELECT * that reaches the output costs I/O for every column.`,
        fix: `-- Select only what you need\nSELECT order_id, amount, ts FROM ${t}\n\n# PySpark\ndf.select("order_id", "amount", "ts")`,
        doc: DOCS.tuning,
      })
    }
  }

  // Filters directly above a scan that were not pushed into it
  for (const f of all(root, (n) => /^Filter$/.test(n.name))) {
    let below = f.children[0]
    while (below && below.children.length === 1 && !isScan(below) && ['filter', 'python', 'other'].includes(below.category)) below = below.children[0]
    if (!below || !isScan(below)) continue
    const cond = f.attrs.Condition ?? ''
    const preds = conjuncts(cond).filter((c) => !/^isnotnull\(/i.test(c))
    const pushed = listOf(below.attrs.PushedFilters).filter((p) => !/^IsNotNull\(/.test(p))
    const blocked = preds.filter((c) => /pythonUDF\d*#|\w\([^()]*\w+#\d+/.test(c) && !/^[A-Z][A-Za-z]*\(\w+#\d+L?, [^()]*\)$/.test(c))
    if (!blocked.length || pushed.length >= preds.length) continue
    const c = blocked[0], col = colOf(c), t = shortName(below.table!)
    const cause = /pythonUDF/.test(c) ? 'it is a Python UDF, which the data source cannot evaluate'
      : /\bcast\(/.test(c) ? `the column is wrapped in a CAST (${/cast\([^()]*\)/.exec(c)?.[0]})`
        : `the column is wrapped in a function (${/(\w+)\(/.exec(c)?.[1]}())`
    add({
      id: `not-pushed:${below.table}`, severity: 'warn', nodes: [f.key, below.key],
      title: `Filter on ${t} not pushed down to the scan`,
      detail: `The predicate ${c} runs after the rows are read, because ${cause}. PushedFilters only contains ${pushed.length ? pushed.join(', ') : 'null checks'}, so the reader cannot skip row groups or files using min/max statistics.`,
      fix: /pythonUDF/.test(c)
        ? `# Replace the UDF in the filter with built-in expressions\ndf.filter(F.col("${col}") >= F.lit("2024-01-01").cast("date"))`
        : `-- Avoid wrapping the column; compare it with typed literals instead\n-- before: WHERE CAST(${col} AS STRING) LIKE '1995%'\nWHERE ${col} >= DATE'1995-01-01' AND ${col} < DATE'1996-01-01'\n\n# PySpark\ndf.filter((F.col("${col}") >= "1995-01-01") & (F.col("${col}") < "1996-01-01"))`,
      doc: DOCS.skipping,
    })
  }

  // Repeated shuffles
  const visitEx = (n: PlanNode, above?: PlanNode) => {
    if (n.category === 'header' && n.name === 'Initial Plan') return
    if (isShuffle(n)) {
      if (above) {
        const keys = (x: PlanNode) => splitTop(/\((.*)\)/.exec(x.attrs.Partitioning ?? '')?.[1] ?? '').filter((k) => !/^\d+$/.test(k)).sort().join(',')
        const same = keys(n) && keys(n) === keys(above) && /^hashpartitioning/.test(n.attrs.Partitioning ?? '')
        const userRepartition = /REPARTITION_BY_(NUM|COL)/.test(n.attrs.Arguments ?? n.text)
        if (same || userRepartition) {
          add({
            id: `reshuffle:${n.key}`, severity: 'warn', nodes: [n.key, above.key],
            title: same ? `Data is shuffled twice on the same keys` : `repartition() is undone by a later shuffle`,
            detail: same
              ? `Two Exchanges partition by ${keys(n)} on the same path. The second shuffle moves all rows again without changing the distribution. This usually comes from an explicit repartition() with a different partition count, or a join/aggregation that could reuse the first shuffle.`
              : `An explicit repartition (${n.attrs.Partitioning}) is followed by another Exchange (${above.attrs.Partitioning}) before any wide operation can use it, so the first shuffle is wasted work.`,
            fix: `# Remove the explicit repartition, or repartition on the keys the next join/aggregation uses\ndf = df.repartition("join_key")   # instead of df.repartition(200)\n\n-- SQL: drop the REPARTITION hint or align its columns\nSELECT /*+ REPARTITION(join_key) */ ...`,
            doc: DOCS.tuning,
          })
        }
      }
      above = n
    } else if (n.category === 'join' || n.category === 'aggregate') above = undefined
    n.children.forEach((c) => visitEx(c, above))
  }
  visitEx(root)

  // Python UDFs
  for (const p of all(root, (n) => n.category === 'python')) {
    const rowAtATime = p.name === 'BatchEvalPython'
    add({
      id: `python:${p.name}`, severity: rowAtATime ? 'warn' : 'info', nodes: [p.key],
      title: rowAtATime ? 'Row-at-a-time Python UDF (BatchEvalPython)' : `Python execution in the plan (${p.name})`,
      detail: rowAtATime
        ? 'Every row is serialized to a Python worker and back. Python UDFs also block predicate pushdown and whole-stage codegen around them. Built-in functions are usually 10-100x faster; a vectorized pandas UDF is the next best option.'
        : 'Data crosses the JVM/Python boundary in Arrow batches. This is much faster than row-at-a-time UDFs, but built-in functions still avoid the serialization entirely and stay inside codegen.',
      fix: `# Prefer built-ins\ndf.withColumn("y", F.upper(F.col("x")))\n\n# Otherwise vectorize with a pandas UDF\nfrom pyspark.sql.functions import pandas_udf\n@pandas_udf("double")\ndef score(v: pd.Series) -> pd.Series:\n    return v * 1.1`,
      doc: DOCS.pandas,
    })
  }

  // AQE status
  if (summary.aqe === 'initial') {
    add({
      id: 'aqe-initial', severity: 'info', nodes: [root.key],
      title: 'Adaptive plan not final (isFinalPlan=false)',
      detail: 'This is the plan before execution. Adaptive Query Execution may still coalesce shuffle partitions, switch sort-merge joins to broadcast joins, and split skewed partitions at runtime. Run the query and call explain() again (or use the Query Profile) to see the final plan.',
      fix: `df.collect()   # or any action\ndf.explain()   # now shows "== Final Plan =="`,
      doc: DOCS.aqe,
    })
  } else if (summary.aqe === 'final') {
    add({ id: 'aqe-final', severity: 'good', nodes: [root.key], title: 'Final adaptive plan', detail: 'This plan reflects runtime decisions made by Adaptive Query Execution (query stages, coalesced shuffle reads, join conversions).', doc: DOCS.aqe })
  }

  // Positive signals
  const bhj = all(root, (n) => /BroadcastHashJoin$/.test(n.name))
  if (bhj.length) add({ id: 'good-bhj', severity: 'good', nodes: bhj.map((n) => n.key), title: `${bhj.length} broadcast hash join${bhj.length > 1 ? 's' : ''}`, detail: 'The build side is broadcast to every executor, so the large side is joined in place without a shuffle.' })
  if (pushedTables.length) add({ id: 'good-pushdown', severity: 'good', nodes: all(root, (n) => isScan(n) && pushedTables.includes(shortName(n.table!))).map((n) => n.key), title: `Filters pushed down on ${[...new Set(pushedTables)].join(', ')}`, detail: 'The scan receives the predicates, so the reader can skip files and row groups using statistics.' })
  if (prunedTables.length) add({ id: 'good-prune', severity: 'good', nodes: all(root, (n) => isScan(n) && listOf(n.attrs.PartitionFilters).length > 0).map((n) => n.key), title: `Partition pruning on ${[...new Set(prunedTables)].join(', ')}`, detail: 'PartitionFilters restrict which partition directories are listed and read.' })

  const rank: Record<Severity, number> = { bad: 0, warn: 1, info: 2, good: 3 }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity])
}

// ---------- diff ----------

export interface PlanDiff {
  stats: { label: string; before: number; after: number }[]
  operators: { op: string; before: number; after: number }[]
  resolved: Finding[]
  introduced: Finding[]
}

function signature(n: PlanNode): string {
  if (n.category === 'scan' && n.table) return `${n.name.replace(/^File/, '')} ${n.table}`
  if (n.category === 'join') return [n.name, n.attrs['Join type']].filter(Boolean).join(' ')
  return n.name
}

export function diffPlans(a: ParsedPlan, b: ParsedPlan): PlanDiff {
  const count = (root: PlanNode) => {
    const m = new Map<string, number>()
    walk(root, (n) => { if (n.category !== 'header' && n.name !== 'WholeStageCodegen' && n.name !== 'InputAdapter') m.set(signature(n), (m.get(signature(n)) ?? 0) + 1) })
    return m
  }
  const ca = count(a.physical), cb = count(b.physical)
  const operators = [...new Set([...ca.keys(), ...cb.keys()])]
    .map((op) => ({ op, before: ca.get(op) ?? 0, after: cb.get(op) ?? 0 }))
    .filter((o) => o.before !== o.after)
    .sort((x, y) => Math.abs(y.after - y.before) - Math.abs(x.after - x.before) || x.op.localeCompare(y.op))
  const sa = summarize(a.physical), sb = summarize(b.physical)
  const joins = (s: Summary) => Object.values(s.joins).reduce((x, y) => x + y, 0)
  const stats = [
    { label: 'Shuffles (Exchange)', before: sa.shuffles, after: sb.shuffles },
    { label: 'Broadcasts', before: sa.broadcasts, after: sb.broadcasts },
    { label: 'Sorts', before: sa.sorts, after: sb.sorts },
    { label: 'Joins', before: joins(sa), after: joins(sb) },
    { label: 'Scans', before: sa.scans, after: sb.scans },
    { label: 'Operators', before: sa.operators, after: sb.operators },
  ]
  // Node keys differ between plans, so compare findings by rule + subject.
  const fa = analyze(a).filter((f) => f.severity !== 'good'), fb = analyze(b).filter((f) => f.severity !== 'good')
  const ruleKey = (f: Finding) => f.title
  return {
    stats,
    operators,
    resolved: fa.filter((f) => !fb.some((g) => ruleKey(g) === ruleKey(f))),
    introduced: fb.filter((f) => !fa.some((g) => ruleKey(g) === ruleKey(f))),
  }
}
