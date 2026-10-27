import { describe, expect, it } from 'vitest'
import type { InterfaceSpec, TeamMember } from '../types'
import { applySpecPatch, emptySpec, listInterfaces, missingSpecFields, SPEC_TEXT_MAX, specsMarkdown } from './interfaces'

const team: TeamMember[] = [
  { id: 'm1', name: 'Kim', color: '#0090ff', capacity: 0 },
  { id: 'm2', name: 'Lee', color: '#e5484d', capacity: 0 },
]
const spec = (patch: Partial<InterfaceSpec> = {}): InterfaceSpec => ({ ...emptySpec(), ...patch })
const card = (id: string, assigneeIds: string[], s: InterfaceSpec | null) => ({ id, title: id, assigneeIds, spec: s })

describe('interfaces', () => {
  it('groups interface cards by who builds them, skipping plain cards', () => {
    const list = listInterfaces(team, [
      { card: card('orders', ['m1'], spec({ status: 'agreed' })), column: 'Spec', done: false },
      { card: card('both', ['m1', 'm2'], spec()), column: 'Done', done: true },
      { card: card('plain', ['m1'], null), column: 'Spec', done: false },
      { card: card('loose', ['gone'], spec()), column: 'Spec', done: false },
    ])
    expect(list.total).toBe(3)
    expect(list.members.map((m) => [m.member.name, m.items.map((i) => i.card.id), m.agreed, m.done])).toEqual([
      ['Kim', ['orders', 'both'], 1, 1],
      ['Lee', ['both'], 0, 1],
    ])
    expect(list.unassigned.map((i) => i.card.id)).toEqual(['loose'])
  })

  it('merges spec changes, removes with null and keeps with undefined', () => {
    const current = spec({ endpoint: 'GET /a' })
    expect(applySpecPatch(current, undefined)).toBe(current)
    expect(applySpecPatch(current, null)).toBeNull()
    expect(applySpecPatch(null, { kind: 'ui' })).toEqual(spec({ kind: 'ui' }))
    expect(applySpecPatch(current, { status: 'review' })).toEqual(spec({ endpoint: 'GET /a', status: 'review' }))
    expect(applySpecPatch(null, { notes: 'x'.repeat(SPEC_TEXT_MAX + 5) })!.notes).toHaveLength(SPEC_TEXT_MAX)
  })

  it('names the empty fields and writes all specs as Markdown', () => {
    expect(missingSpecFields(spec({ endpoint: 'GET /a', input: ' ' }))).toEqual(['Input', 'Output', 'Notes'])
    const list = listInterfaces(team, [
      { card: card('Create order', ['m1'], spec({ endpoint: 'POST /orders', input: '{ sku }' })), column: 'Spec', done: false },
    ])
    const md = specsMarkdown('Checkout', list)
    expect(md).toContain('# Checkout: interface specs')
    expect(md).toContain('## Kim\n\n### Create order')
    expect(md).toContain('- Endpoint: `POST /orders`')
    expect(md).toContain('**Input**\n\n{ sku }')
    expect(md).not.toContain('**Output**')
    expect(md).not.toContain('## Lee')
  })
})
