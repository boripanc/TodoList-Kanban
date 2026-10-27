import type { InterfaceKind, InterfaceSpec, SpecStatus, TeamMember } from '../types'

export const interfaceKinds: InterfaceKind[] = ['api', 'event', 'ui', 'file', 'database', 'other']
export const specStatuses: SpecStatus[] = ['draft', 'review', 'agreed']

export const kindName: Record<InterfaceKind, string> = {
  api: 'API',
  event: 'Event / message',
  ui: 'UI screen',
  file: 'File / batch',
  database: 'Database',
  other: 'Other',
}

/** Short names for the card face. */
export const kindShort: Record<InterfaceKind, string> = {
  api: 'API',
  event: 'Event',
  ui: 'UI',
  file: 'File',
  database: 'DB',
  other: 'Interface',
}

export const statusName: Record<SpecStatus, string> = {
  draft: 'Draft',
  review: 'In review',
  agreed: 'Agreed',
}

/** What each text field of a spec holds, with a hint shown while it is empty. */
export const specFields: { key: 'endpoint' | 'input' | 'output' | 'notes'; name: string; hint: string }[] = [
  { key: 'endpoint', name: 'Endpoint / name', hint: 'e.g. POST /v1/orders, orders.created topic, Checkout screen' },
  { key: 'input', name: 'Input', hint: 'Request body, parameters, message or file layout' },
  { key: 'output', name: 'Output', hint: 'Response, events emitted, error codes' },
  { key: 'notes', name: 'Notes', hint: 'Auth, limits, error handling, who calls it' },
]

/** Longest text a spec field may hold. */
export const SPEC_TEXT_MAX = 20_000

export function emptySpec(kind: InterfaceKind = 'api'): InterfaceSpec {
  return { kind, endpoint: '', input: '', output: '', notes: '', status: 'draft' }
}

/**
 * A spec after a change: `undefined` keeps it, `null` removes it, and a patch
 * is merged in (starting from an empty spec when there was none). Long text is cut.
 */
export function applySpecPatch(
  current: InterfaceSpec | null,
  patch: Partial<InterfaceSpec> | null | undefined,
): InterfaceSpec | null {
  if (patch === undefined) return current
  if (patch === null) return null
  const next: InterfaceSpec = { ...(current ?? emptySpec()), ...patch }
  for (const f of specFields) next[f.key] = next[f.key].slice(0, SPEC_TEXT_MAX)
  return next
}

/** Spec fields still empty, by name; an agreed spec should have none. */
export function missingSpecFields(spec: InterfaceSpec): string[] {
  return specFields.filter((f) => !spec[f.key].trim()).map((f) => f.name)
}

interface SpecCard {
  id: string
  title: string
  assigneeIds: string[]
  spec: InterfaceSpec | null
}

export interface InterfaceItem<C extends SpecCard> {
  card: C & { spec: InterfaceSpec }
  /** Title of the column the card sits in. */
  column: string
  done: boolean
}

export interface MemberInterfaces<C extends SpecCard> {
  member: TeamMember
  items: InterfaceItem<C>[]
  agreed: number
  done: number
}

export interface InterfaceList<C extends SpecCard> {
  members: MemberInterfaces<C>[]
  /** Interfaces nobody is assigned to yet. */
  unassigned: InterfaceItem<C>[]
  total: number
}

/**
 * Every interface (card with a spec) on a board, grouped by the team member
 * who builds it. A card with two people shows under both.
 */
export function listInterfaces<C extends SpecCard>(
  team: TeamMember[],
  items: { card: C; column: string; done: boolean }[],
): InterfaceList<C> {
  const withSpec = items.filter((i): i is InterfaceItem<C> => i.card.spec !== null)
  const members = team.map((member) => {
    const mine = withSpec.filter((i) => i.card.assigneeIds.includes(member.id))
    return {
      member,
      items: mine,
      agreed: mine.filter((i) => i.card.spec.status === 'agreed').length,
      done: mine.filter((i) => i.done).length,
    }
  })
  const teamIds = new Set(team.map((m) => m.id))
  const unassigned = withSpec.filter((i) => !i.card.assigneeIds.some((id) => teamIds.has(id)))
  return { members, unassigned, total: withSpec.length }
}

/** All interface specs on a board as one Markdown document, grouped by person. */
export function specsMarkdown<C extends SpecCard>(boardTitle: string, list: InterfaceList<C>): string {
  const out: string[] = [`# ${boardTitle}: interface specs`, '']
  const section = (heading: string, items: InterfaceItem<C>[]) => {
    if (items.length === 0) return
    out.push(`## ${heading}`, '')
    for (const { card, column } of items) {
      const spec = card.spec
      out.push(`### ${card.title}`, '')
      out.push(`- Kind: ${kindName[spec.kind]}`, `- Spec: ${statusName[spec.status]}`, `- Column: ${column}`)
      if (spec.endpoint.trim()) out.push(`- Endpoint: \`${spec.endpoint.trim()}\``)
      out.push('')
      for (const field of specFields.slice(1)) {
        const text = spec[field.key].trim()
        if (text) out.push(`**${field.name}**`, '', text, '')
      }
    }
  }
  for (const m of list.members) section(m.member.name, m.items)
  section('Unassigned', list.unassigned)
  if (list.total === 0) out.push('No interfaces yet.', '')
  return out.join('\n')
}
