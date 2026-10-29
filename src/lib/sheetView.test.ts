// @vitest-environment node
import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { applyTint, columnLetter, cssColor, formatValue, themeColors, workbookView } from './sheetView'

describe('formatValue', () => {
  it('formats numbers like Excel', () => {
    expect(formatValue(1234567.891, '#,##0.00')).toBe('1,234,567.89')
    expect(formatValue(0.256, '0.0%')).toBe('25.6%')
    expect(formatValue(-5, '0.00;[Red](0.00)')).toBe('(5.00)')
    expect(formatValue(-5, '0.00')).toBe('-5.00')
    expect(formatValue(1500, '[$฿-41E]#,##0')).toBe('฿1,500')
    expect(formatValue(3, '000')).toBe('003')
    expect(formatValue(0.5, '#.##')).toBe('.5')
    expect(formatValue(12, '"Qty: "0')).toBe('Qty: 12')
    expect(formatValue(1 / 3, 'General')).toBe('0.3333333333')
    expect(formatValue(42, undefined)).toBe('42')
    expect(formatValue(true, undefined)).toBe('TRUE')
    expect(formatValue('text', '0.00')).toBe('text')
  })

  it('formats dates and times', () => {
    const date = new Date(Date.UTC(2026, 10, 5, 14, 7, 9))
    expect(formatValue(date, 'dd/mm/yyyy')).toBe('05/11/2026')
    expect(formatValue(date, 'd-mmm-yy')).toBe('5-Nov-26')
    expect(formatValue(date, 'yyyy-mm-dd hh:mm:ss')).toBe('2026-11-05 14:07:09')
    expect(formatValue(date, 'h:mm AM/PM')).toBe('2:07 PM')
    expect(formatValue(date, 'dddd d mmmm')).toBe('Thursday 5 November')
    expect(formatValue(date, '14')).toBe('11/5/2026')
  })
})

describe('colours', () => {
  it('reads theme colours and tints them', () => {
    const xml =
      '<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="0E2841"/></a:dk2><a:lt2><a:srgbClr val="E8E8E8"/></a:lt2><a:accent1><a:srgbClr val="156082"/></a:accent1></a:clrScheme>'
    const theme = themeColors(xml)
    expect(theme.slice(0, 5)).toEqual(['FFFFFF', '000000', 'E8E8E8', '0E2841', '156082'])
    expect(cssColor({ theme: 4 }, theme)).toBe('#156082')
    expect(cssColor({ argb: 'FF1F4E79' }, theme)).toBe('#1F4E79')
    expect(cssColor({ indexed: 2 } as never, theme)).toBe('#FF0000')
    expect(applyTint('000000', 0.5)).toBe('808080')
    expect(applyTint('FFFFFF', -0.5)).toBe('808080')
  })

  it('names columns', () => {
    expect([0, 25, 26, 701, 702].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA'])
  })
})

describe('workbookView', () => {
  it('keeps widths, merges, styles and borders, and leaves out hidden sheets', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Mapping')
    wb.addWorksheet('Secret', { state: 'hidden' })
    ws.getColumn(1).width = 20
    ws.getColumn(3).hidden = true
    ws.mergeCells('A1:D1')
    ws.getCell('A1').value = 'Field mapping'
    ws.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' }, name: 'Calibri' }
    ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } }
    ws.getCell('A1').alignment = { horizontal: 'center' }
    ws.getRow(1).height = 30
    ws.getCell('A2').value = 'MATNR'
    ws.getCell('A2').border = { right: { style: 'medium', color: { argb: 'FFC00000' } } }
    ws.getCell('B2').value = 0.25
    ws.getCell('B2').numFmt = '0%'
    ws.getCell('B3').value = { formula: 'B2*2', result: 0.5 }
    ws.getCell('B3').numFmt = '0%'
    ws.getCell('A3').value = { richText: [{ text: 'Bold', font: { bold: true } }, { text: ' plain' }] }

    // A round trip through the file format, as the viewer reads it.
    const read = new ExcelJS.Workbook()
    await read.xlsx.load(await wb.xlsx.writeBuffer())
    const view = workbookView(read, () => undefined)
    expect(view.sheets.map((s) => s.name)).toEqual(['Mapping'])
    const sheet = view.sheets[0]
    expect(sheet.columns.map((c) => c.letter)).toEqual(['A', 'B', 'D'])
    expect(sheet.columns[0].width).toBe(145)
    expect(sheet.rows[0]).toMatchObject({ number: 1, height: 40 })
    const title = sheet.rows[0].cells[0]
    // The merge spans the three visible columns.
    expect(title).toMatchObject({ text: 'Field mapping', colSpan: 3, rowSpan: 1 })
    expect(title.style).toMatchObject({ fontWeight: '700', fontSize: '16pt', color: '#FFFFFF', backgroundColor: '#1F4E79', textAlign: 'center' })
    const [matnr, share] = sheet.rows[1].cells
    expect(matnr.style.borderRight).toBe('2px solid #C00000')
    expect(share).toMatchObject({ text: '25%', style: { textAlign: 'right' } })
    expect(sheet.rows[2].cells[1].text).toBe('50%')
    expect(sheet.rows[2].cells[0].runs).toEqual([
      { text: 'Bold', style: { fontWeight: '700' } },
      { text: ' plain', style: {} },
    ])
  })
})
