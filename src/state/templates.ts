import type { Label } from '../types'

export type BoardTemplate = 'work' | 'personal' | 'blank'

export const templateColumns: Record<BoardTemplate, string[]> = {
  work: ['Backlog', 'To do', 'In progress', 'Review', 'Done'],
  personal: ['To do', 'Doing', 'Done'],
  blank: [],
}

export const labelColors = [
  '#e5484d', // red
  '#f76b15', // orange
  '#ffc53d', // amber
  '#30a46c', // green
  '#12a594', // teal
  '#0090ff', // blue
  '#8e4ec6', // purple
  '#d6409f', // pink
  '#8b8d98', // gray
]

export const templateLabels: Record<BoardTemplate, Omit<Label, 'id'>[]> = {
  work: [
    { name: 'Bug', color: '#e5484d' },
    { name: 'Feature', color: '#0090ff' },
    { name: 'Meeting', color: '#8e4ec6' },
    { name: 'Docs', color: '#12a594' },
  ],
  personal: [
    { name: 'Home', color: '#30a46c' },
    { name: 'Errand', color: '#f76b15' },
    { name: 'Health', color: '#d6409f' },
    { name: 'Finance', color: '#ffc53d' },
  ],
  blank: [],
}
