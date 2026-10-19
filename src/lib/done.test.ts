import { describe, expect, it } from 'vitest'
import { isDoneColumn } from './done'

describe('isDoneColumn', () => {
  it('recognises done and closed columns', () => {
    for (const title of ['Done', 'done', 'Closed', 'Completed', 'Finished', 'Done ✅', 'Done this week']) {
      expect(isDoneColumn(title)).toBe(true)
    }
  })

  it('ignores other columns', () => {
    for (const title of ['To do', 'In progress', 'Review', 'Backlog', 'Undone ideas', 'Doing']) {
      expect(isDoneColumn(title)).toBe(false)
    }
  })
})
