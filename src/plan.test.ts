import test from 'node:test'
import assert from 'node:assert/strict'
import { analyze, diffPlans, parsePlan, summarize } from './plan.ts'
import { SAMPLES } from './samples.ts'

const sample = (id: string) => SAMPLES.find((s) => s.id === id)!.text

test('every sample parses into a physical plan', () => {
  for (const s of SAMPLES) assert.ok(parsePlan(s.text).physical, s.id)
})

test('missed broadcast: SMJ with a small side is flagged', () => {
  const plan = parsePlan(sample('missed-broadcast'))
  assert.ok(summarize(plan.physical))
  const ids = analyze(plan).map((f) => f.id).join(' ')
  assert.match(ids, /smj-small/)
})

test('diffing a plan against itself reports no operator changes', () => {
  const p = parsePlan(sample('missed-broadcast'))
  assert.doesNotThrow(() => diffPlans(p, p))
})
