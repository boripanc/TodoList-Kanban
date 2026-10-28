import type { AdapterType, InterfaceSpec, MessageMode, SpecStatus, TeamMember } from '../types'

/** CPI adapters, grouped the way they show in the iFlow editor. */
export const adapterGroups: { name: string; adapters: AdapterType[] }[] = [
  { name: 'SAP', adapters: ['idoc', 'rfc', 'xi', 'successfactors', 'ariba'] },
  { name: 'Web services', adapters: ['soap', 'http', 'odata'] },
  { name: 'Files and B2B', adapters: ['sftp', 'ftp', 'mail', 'as2', 'as4'] },
  { name: 'Messaging and data', adapters: ['jms', 'amqp', 'kafka', 'jdbc', 'ldap'] },
  { name: 'Other', adapters: ['processdirect', 'openconnectors', 'aws', 'azure', 'other'] },
]
export const adapterTypes: AdapterType[] = adapterGroups.flatMap((g) => g.adapters)
export const messageModes: MessageMode[] = ['async', 'sync']
export const specStatuses: SpecStatus[] = ['draft', 'review', 'agreed']

export const adapterName: Record<AdapterType, string> = {
  idoc: 'IDoc',
  rfc: 'RFC / BAPI',
  xi: 'XI (PI/PO, S/4 proxy)',
  successfactors: 'SuccessFactors',
  ariba: 'Ariba',
  soap: 'SOAP',
  http: 'HTTP / REST',
  odata: 'OData',
  sftp: 'SFTP',
  ftp: 'FTP',
  mail: 'Mail',
  as2: 'AS2 (EDI)',
  as4: 'AS4',
  jms: 'JMS',
  amqp: 'AMQP',
  kafka: 'Kafka',
  jdbc: 'JDBC',
  ldap: 'LDAP',
  processdirect: 'ProcessDirect',
  openconnectors: 'Open Connectors',
  aws: 'Amazon Web Services',
  azure: 'Microsoft Azure',
  other: 'Other',
}

/** Short names for the card face. */
export const adapterShort: Record<AdapterType, string> = {
  ...adapterName,
  rfc: 'RFC',
  xi: 'XI',
  successfactors: 'SF',
  http: 'HTTP',
  as2: 'AS2',
  openconnectors: 'OpenConn',
  aws: 'AWS',
  azure: 'Azure',
}

export const modeName: Record<MessageMode, string> = {
  async: 'Asynchronous',
  sync: 'Synchronous',
}

export const statusName: Record<SpecStatus, string> = {
  draft: 'Draft',
  review: 'In review',
  agreed: 'Agreed',
}

type TextKey = 'senderSystem' | 'receiverSystem' | 'endpoint' | 'notes'

/** What each text field of a spec holds, with a hint shown while it is empty. */
export const specFields: { key: TextKey; name: string; hint: string }[] = [
  { key: 'senderSystem', name: 'Sender system', hint: 'e.g. S/4HANA PRD' },
  { key: 'receiverSystem', name: 'Receiver system', hint: 'e.g. Salesforce' },
  { key: 'endpoint', name: 'iFlow / endpoint', hint: 'iFlow name, address (/orders/create), IDoc type or folder' },
  { key: 'notes', name: 'Notes', hint: 'Auth, error handling, retries, volume, schedule' },
]

/** Longest text a spec field may hold. */
export const SPEC_TEXT_MAX = 20_000

export function emptySpec(senderAdapter: AdapterType = 'idoc', receiverAdapter: AdapterType = 'http'): InterfaceSpec {
  return {
    senderSystem: '',
    senderAdapter,
    receiverSystem: '',
    receiverAdapter,
    mode: 'async',
    endpoint: '',
    notes: '',
    status: 'draft',
  }
}

/**
 * Specs saved before version 7 had a source message and a target message
 * field. Those are gone (the technical and mapping spec files hold that now),
 * so any text in them moves to the end of the notes rather than being lost.
 */
export function withoutMessageFields(spec: InterfaceSpec & { input?: unknown; output?: unknown }): InterfaceSpec {
  const { input, output, ...rest } = spec
  const parts = [rest.notes.trim()]
  if (typeof input === 'string' && input.trim()) parts.push(`Source message:\n${input.trim()}`)
  if (typeof output === 'string' && output.trim()) parts.push(`Target message and mapping:\n${output.trim()}`)
  const notes = parts.filter(Boolean).join('\n\n')
  return { ...rest, notes: notes === rest.notes.trim() ? rest.notes : notes }
}

/** "S/4HANA (IDoc) → Salesforce (HTTP / REST)", leaving out systems not named yet. */
export function routeText(spec: InterfaceSpec, short = false): string {
  const names = short ? adapterShort : adapterName
  const side = (system: string, adapter: AdapterType) =>
    system.trim() ? `${system.trim()} (${names[adapter]})` : names[adapter]
  return `${side(spec.senderSystem, spec.senderAdapter)} → ${side(spec.receiverSystem, spec.receiverAdapter)}`
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

/** All interface specs on a board as one Markdown document, grouped by person, naming each one's attached files. */
export function specsMarkdown<C extends SpecCard>(
  boardTitle: string,
  list: InterfaceList<C>,
  files: Record<string, string[]> = {},
): string {
  const out: string[] = [`# ${boardTitle}: interface specs`, '']
  const section = (heading: string, items: InterfaceItem<C>[]) => {
    if (items.length === 0) return
    out.push(`## ${heading}`, '')
    for (const { card, column } of items) {
      const spec = card.spec
      out.push(`### ${card.title}`, '')
      out.push(
        `- Sender: ${spec.senderSystem.trim() || '(not set)'} via ${adapterName[spec.senderAdapter]}`,
        `- Receiver: ${spec.receiverSystem.trim() || '(not set)'} via ${adapterName[spec.receiverAdapter]}`,
        `- Mode: ${modeName[spec.mode]}`,
        `- Spec: ${statusName[spec.status]}`,
        `- Column: ${column}`,
      )
      if (spec.endpoint.trim()) out.push(`- iFlow / endpoint: \`${spec.endpoint.trim()}\``)
      if (files[card.id]?.length) out.push(`- Files: ${files[card.id].join(', ')}`)
      out.push('')
      if (spec.notes.trim()) out.push('**Notes**', '', spec.notes.trim(), '')
    }
  }
  for (const m of list.members) section(m.member.name, m.items)
  section('Unassigned', list.unassigned)
  if (list.total === 0) out.push('No interfaces yet.', '')
  return out.join('\n')
}
