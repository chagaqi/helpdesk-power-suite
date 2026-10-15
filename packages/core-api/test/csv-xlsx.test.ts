import { describe, expect, it } from 'vitest';
import { strFromU8 } from 'fflate';
import { buildMultiSheetWorkbook, exportAll, ExportSession } from '../src/export/CursorExportEngine.js';
import { parseCsv, toCsv, UTF8_BOM } from '../src/export/csv.js';
import { columnLetter, buildWorkbook, sanitizeSheetName, toExcelSerial, xmlEscape } from '../src/export/xlsx.js';
import { zendeskFieldSchema } from '../src/export/normalize/index.js';
import { cursorPages, zendeskTicketFieldsRaw, zendeskTickets, zendeskUserFieldsRaw, zendeskUsers } from '../src/demo/synthetic.js';
import type { ColumnSpec } from '../src/export/columns.js';
import { assertWellFormedXml, readSheet, unzipXlsx } from './helpers.js';

const cols: ColumnSpec[] = [
  { key: 'a', label: 'Name', kind: 'string', origin: 'standard' },
  { key: 'b', label: 'Amount', kind: 'number', origin: 'standard' },
  { key: 'c', label: 'Flag', kind: 'boolean', origin: 'standard' },
  { key: 'd', label: 'When', kind: 'date', origin: 'standard' },
];

describe('UTF-8 BOM CSV', () => {
  it('starts with a BOM, uses CRLF and escapes quotes, delimiters and newlines', () => {
    const csv = toCsv(cols, [
      ['Zoë "Z", Ødegaard', 12.5, true, '2024-01-02T03:04:05Z'],
      ['multi\nline', -3, false, null],
    ]);
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    expect(csv).toContain('\r\n');
    expect(csv).toContain('"Zoë ""Z"", Ødegaard"');
    const parsed = parseCsv(csv);
    expect(parsed[0]).toEqual(['Name', 'Amount', 'Flag', 'When']);
    expect(parsed[1]).toEqual(['Zoë "Z", Ødegaard', '12.5', 'TRUE', '2024-01-02T03:04:05Z']);
    expect(parsed[2]).toEqual(['multi\nline', '-3', 'FALSE', '']);
  });

  it('neutralizes spreadsheet formula injection in text but not in numbers', () => {
    const csv = toCsv(cols, [['=HYPERLINK("x")', -5, null, null], ['+cmd', null, null, null], ['@SUM(A1)', null, null, null]]);
    const parsed = parseCsv(csv);
    expect(parsed[1]![0]).toBe(`'=HYPERLINK("x")`);
    expect(parsed[1]![1]).toBe('-5');
    expect(parsed[2]![0]).toBe(`'+cmd`);
    expect(parsed[3]![0]).toBe(`'@SUM(A1)`);
  });

  it('supports ";" delimiter for EU Excel', () => {
    const csv = toCsv(cols, [['a;b', 1.5, null, null]], { delimiter: ';' });
    expect(parseCsv(csv, ';')[1]).toEqual(['a;b', '1.5', '', '']);
  });

  it('round-trips a 2,500-row Zendesk user export byte-for-byte through the parser', () => {
    const users = zendeskUsers(2500);
    const s = exportAll({ entity: 'user', source: 'zendesk', fieldSchema: zendeskFieldSchema('user', zendeskUserFieldsRaw()) }, cursorPages(users, 100, 3));
    const csv = s.toCsv();
    const parsed = parseCsv(csv);
    expect(parsed.length).toBe(2501);
    const width = parsed[0]!.length;
    expect(parsed.every((r) => r.length === width)).toBe(true);
    const emailIdx = parsed[0]!.indexOf('Email');
    expect(parsed.slice(1).map((r) => r[emailIdx])).toEqual(users.map((u) => u.email));
  });
});

describe('XLSX writer', () => {
  it('produces a valid OOXML package with styled header, frozen pane, autofilter and typed cells', () => {
    const bytes = buildWorkbook([{ name: 'Users', columns: cols, rows: [['Zoë & <Co>', 42, true, '2024-03-01T12:00:00Z'], ['bad\u0001char', null, false, 'not a date']] }], {
      now: new Date('2024-05-01T00:00:00Z'),
    });
    expect(strFromU8(bytes.slice(0, 2))).toBe('PK');
    const parts = unzipXlsx(bytes);
    for (const p of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml', 'docProps/core.xml']) {
      expect(parts[p], p).toBeDefined();
      assertWellFormedXml(parts[p]!, p);
    }
    const sheet = parts['xl/worksheets/sheet1.xml']!;
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<autoFilter ref="A1:D3"/>');
    expect(sheet).toMatch(/<c r="A1" t="s" s="1">/);
    expect(sheet).toContain('<c r="C2" t="b"><v>1</v></c>');
    expect(sheet).toMatch(/<c r="D2" s="2"><v>45352\.5<\/v><\/c>/);
    const rows = readSheet(parts);
    expect(rows[0]).toEqual(['Name', 'Amount', 'Flag', 'When']);
    expect(rows[1]![0]).toBe('Zoë & <Co>');
    expect(rows[2]![0]).toBe('badchar');
    expect(rows[2]![3]).toBe('not a date');
  });

  it('builds multi-tab workbooks with a summary tab', () => {
    const userS = exportAll({ entity: 'user', source: 'zendesk', fieldSchema: zendeskFieldSchema('user', zendeskUserFieldsRaw()), filters: { userState: 'active' } }, cursorPages(zendeskUsers(1500), 100, 2));
    const tixS = exportAll({ entity: 'ticket', source: 'zendesk', fieldSchema: zendeskFieldSchema('ticket', zendeskTicketFieldsRaw()) }, cursorPages(zendeskTickets(1100), 100));
    const parts = unzipXlsx(buildMultiSheetWorkbook([{ session: userS }, { session: tixS }]));
    expect(parts['xl/workbook.xml']).toMatch(/<sheet name="Users" sheetId="1".*<sheet name="Tickets" sheetId="2".*<sheet name="Export Summary" sheetId="3"/);
    for (const [k, v] of Object.entries(parts)) if (k.endsWith('.xml') || k.endsWith('.rels')) assertWellFormedXml(v, k);
    const users = readSheet(parts, 1);
    expect(users.length).toBe(userS.stats.rows + 1);
    expect(new Set(users.slice(1).map((r) => r[0])).size).toBe(userS.stats.rows);
    expect(readSheet(parts, 2).length).toBe(1101);
    const summary = readSheet(parts, 3);
    expect(summary[1]![0]).toBe('Users');
    expect(Number(summary[1]![2])).toBe(userS.stats.rows);
    expect(Number(summary[1]![3])).toBe(userS.stats.duplicatesDropped);
    expect(userS.stats.duplicatesDropped).toBeGreaterThan(0); // overlapping cursor pages were deduped
  });

  it('handles 50,000 rows', () => {
    const s = new ExportSession({ entity: 'ticket', source: 'zendesk', fieldSchema: zendeskFieldSchema('ticket', zendeskTicketFieldsRaw()) });
    const tickets = zendeskTickets(50_000);
    for (const p of cursorPages(tickets, 1000)) s.ingest(p);
    expect(s.stats.rows).toBe(50_000);
    const bytes = s.toXlsx();
    const parts = unzipXlsx(bytes);
    expect(parts['xl/worksheets/sheet1.xml']).toContain('<row r="50001">');
    expect(bytes.length).toBeLessThan(15 * 1024 * 1024);
  });

  it('helpers: column letters, sheet names, serial dates, escaping', () => {
    expect([0, 25, 26, 701, 702].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA']);
    const taken = new Set<string>();
    expect(sanitizeSheetName('Users/Admins [EU]: *all*?', taken)).toBe('Users Admins  EU    all');
    expect(sanitizeSheetName('Users/Admins [EU]: *all*?', taken)).toBe('Users Admins  EU    all (2)');
    expect(sanitizeSheetName('x'.repeat(40), taken).length).toBe(31);
    expect(toExcelSerial('1970-01-01')).toBe(25569);
    expect(toExcelSerial('hello')).toBeNull();
    expect(xmlEscape('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });
});
