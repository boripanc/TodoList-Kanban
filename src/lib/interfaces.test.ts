import { describe, expect, it } from 'vitest'
import type { InterfaceSpec, TeamMember } from '../types'
import { applySpecPatch, emptySpec, listInterfaces, routeText, missingSpecFields, SPEC_TEXT_MAX, specsMarkdown, withoutMessageFields } from './interfaces'

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
    expect(applySpecPatch(null, { senderAdapter: 'sftp' })).toEqual(spec({ senderAdapter: 'sftp' }))
    expect(applySpecPatch(current, { status: 'review' })).toEqual(spec({ endpoint: 'GET /a', status: 'review' }))
    expect(applySpecPatch(null, { notes: 'x'.repeat(SPEC_TEXT_MAX + 5) })!.notes).toHaveLength(SPEC_TEXT_MAX)
  })

  it('describes the route from sender to receiver', () => {
    expect(routeText(spec())).toBe('IDoc → HTTP / REST')
    expect(routeText(spec({ senderSystem: 'S/4HANA', receiverSystem: 'Salesforce', senderAdapter: 'rfc' }), true)).toBe(
      'S/4HANA (RFC) → Salesforce (HTTP)',
    )
  })

  it('names the empty fields and writes all specs as Markdown', () => {
    expect(missingSpecFields(spec({ senderSystem: 'S/4', receiverSystem: 'CRM', endpoint: 'x', notes: ' ' }))).toEqual(['Notes'])
    const list = listInterfaces(team, [
      { card: card('Create order', ['m1'], spec({ senderSystem: 'S/4HANA', receiverAdapter: 'odata', endpoint: 'ORDERS05', notes: 'Basic auth' })), column: 'Spec', done: false },
    ])
    const md = specsMarkdown('Checkout', list, { 'Create order': ['spec.docx', 'mapping.xlsx'] })
    expect(md).toContain('# Checkout: interface specs')
    expect(md).toContain('## Kim\n\n### Create order')
    expect(md).toContain('- Sender: S/4HANA via IDoc')
    expect(md).toContain('- Receiver: (not set) via OData')
    expect(md).toContain('- Mode: Asynchronous')
    expect(md).toContain('- Files: spec.docx, mapping.xlsx')
    expect(md).toContain('- iFlow / endpoint: `ORDERS05`')
    expect(md).toContain('**Notes**\n\nBasic auth')
    expect(md).not.toContain('Source message')
    expect(md).not.toContain('## Lee')
  })

  it('moves text from the old message fields into the notes', () => {
    const old = { ...spec({ notes: 'OAuth' }), input: 'IDoc ORDERS05', output: ' ' }
    const moved = withoutMessageFields(old)
    expect(moved).not.toHaveProperty('input')
    expect(moved).not.toHaveProperty('output')
    expect(moved.notes).toBe('OAuth\n\nSource message:\nIDoc ORDERS05')
    expect(withoutMessageFields(spec({ notes: 'kept as is ' })).notes).toBe('kept as is ')
    expect(withoutMessageFields({ ...spec(), output: 'Map A to B' }).notes).toBe('Target message and mapping:\nMap A to B')
  })
})
