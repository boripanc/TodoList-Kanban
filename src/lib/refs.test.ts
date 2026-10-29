import { describe, expect, it } from 'vitest'
import { cleanRef, isProjectBoard, refText } from './refs'

describe('refs', () => {
  it('trims and caps numbers', () => {
    expect(cleanRef('  1024 ')).toBe('1024')
    expect(cleanRef('x'.repeat(150))).toHaveLength(100)
  })

  it('labels numbers on the card face without doubling a typed prefix', () => {
    expect(refText('R4C', '1024')).toBe('R4C 1024')
    expect(refText('R4C', 'r4c-1024')).toBe('r4c-1024')
    expect(refText('DD', 'DD77')).toBe('DD77')
  })

  it('tells Project boards by a Spec column or interface cards', () => {
    const columns = { a: { title: ' spec ', cardIds: [] }, b: { title: 'To do', cardIds: ['c'] } }
    expect(isProjectBoard({ columnIds: ['a'] }, columns, {})).toBe(true)
    expect(isProjectBoard({ columnIds: ['b'] }, columns, { c: { spec: null } })).toBe(false)
    expect(isProjectBoard({ columnIds: ['b'] }, columns, { c: { spec: {} as never } })).toBe(true)
  })
})
