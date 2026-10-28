import { describe, expect, it } from 'vitest'
import { parseCsv } from './csv'

describe('parseCsv', () => {
  it('reads quoted fields, doubled quotes and line breaks', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n"two\nlines",\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['two\nlines', ''],
    ])
  })

  it('reads semicolon files and a last line without a break', () => {
    expect(parseCsv('Source;Target\nMATNR;sku')).toEqual([
      ['Source', 'Target'],
      ['MATNR', 'sku'],
    ])
    expect(parseCsv('')).toEqual([])
  })
})
