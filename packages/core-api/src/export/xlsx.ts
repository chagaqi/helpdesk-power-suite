import { zipSync, type Zippable } from 'fflate';
import type { Primitive } from '../types.js';
import { utf8 } from '../util/encoding.js';
import type { ColumnSpec } from './columns.js';

/**
 * Pure-JS Office Open XML (SpreadsheetML) writer. Produces styled, multi-tab workbooks:
 * bold filled header row, frozen header pane, auto-filter, sized columns, real date and boolean
 * cells, shared-string table. Runs in Node and browsers (fflate for DEFLATE).
 */

export interface SheetInput {
  name: string;
  columns: ColumnSpec[];
  rows: Iterable<Primitive[]>;
}

export interface WorkbookOptions {
  title?: string;
  creator?: string;
  /** Fixed timestamp for reproducible output (tests). */
  now?: Date;
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const EXCEL_MAX_ROWS = 1_048_576;
const EXCEL_MAX_CELL_CHARS = 32_767;

// Style indices into cellXfs (see stylesXml).
const STYLE = { default: 0, header: 1, date: 2, number: 3, wrap: 4 } as const;

// Strip characters that are illegal in XML 1.0 (they corrupt the workbook).
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export function xmlEscape(text: string): string {
  return text
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Excel sheet names: <= 31 chars, no []:*?/\ and unique (case-insensitive). */
export function sanitizeSheetName(name: string, taken: Set<string>): string {
  let base = name.replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim() || 'Sheet';
  base = base.slice(0, 31);
  let candidate = base;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) {
    const suffix = ` (${i})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Converts an ISO-8601 string to an Excel serial date (UTC), or null if not a date. */
export function toExcelSerial(value: string): number | null {
  if (!ISO_DATE.test(value)) return null;
  const ms = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(ms)) return null;
  return ms / 86_400_000 + 25_569;
}

class SharedStrings {
  private readonly index = new Map<string, number>();
  readonly list: string[] = [];
  count = 0;
  add(s: string): number {
    this.count++;
    let i = this.index.get(s);
    if (i === undefined) {
      i = this.list.length;
      this.list.push(s);
      this.index.set(s, i);
    }
    return i;
  }
  toXml(): string {
    const items = this.list.map((s) => {
      const t = xmlEscape(s);
      const preserve = /^\s|\s$|\n/.test(s) ? ' xml:space="preserve"' : '';
      return `<si><t${preserve}>${t}</t></si>`;
    });
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${this.count}" uniqueCount="${this.list.length}">${items.join('')}</sst>`;
  }
}

function cellXml(ref: string, value: Primitive, col: ColumnSpec, sst: SharedStrings): { xml: string; width: number } {
  if (value === null || value === undefined || value === '') return { xml: '', width: 0 };
  if (typeof value === 'boolean') return { xml: `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`, width: 5 };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { xml: '', width: 0 };
    return { xml: `<c r="${ref}" s="${STYLE.number}"><v>${value}</v></c>`, width: String(value).length };
  }
  if (col.kind === 'date') {
    const serial = toExcelSerial(value);
    if (serial !== null) return { xml: `<c r="${ref}" s="${STYLE.date}"><v>${serial}</v></c>`, width: 16 };
  }
  if (col.kind === 'number' && /^-?\d+(\.\d+)?$/.test(value) && value.length < 16) {
    return { xml: `<c r="${ref}" s="${STYLE.number}"><v>${Number(value)}</v></c>`, width: value.length };
  }
  const text = value.length > EXCEL_MAX_CELL_CHARS ? value.slice(0, EXCEL_MAX_CELL_CHARS) : value;
  const idx = sst.add(text);
  const longest = text.split('\n').reduce((m, l) => Math.max(m, l.length), 0);
  return { xml: `<c r="${ref}" t="s"${text.includes('\n') ? ` s="${STYLE.wrap}"` : ''}><v>${idx}</v></c>`, width: longest };
}

function sheetXml(sheet: SheetInput, sst: SharedStrings): { xml: string; rowCount: number } {
  const cols = sheet.columns;
  const widths = cols.map((c) => Math.max(8, c.label.length + 2));
  const rowsXml: string[] = [];
  const header = cols
    .map((c, i) => `<c r="${columnLetter(i)}1" t="s" s="${STYLE.header}"><v>${sst.add(c.label)}</v></c>`)
    .join('');
  rowsXml.push(`<row r="1">${header}</row>`);
  let r = 1;
  for (const row of sheet.rows) {
    r++;
    if (r > EXCEL_MAX_ROWS) throw new RangeError(`Sheet "${sheet.name}" exceeds Excel's ${EXCEL_MAX_ROWS} row limit`);
    let cells = '';
    for (let i = 0; i < cols.length; i++) {
      const { xml, width } = cellXml(`${columnLetter(i)}${r}`, row[i] ?? null, cols[i]!, sst);
      cells += xml;
      if (width + 2 > widths[i]!) widths[i] = width + 2;
    }
    rowsXml.push(`<row r="${r}">${cells}</row>`);
  }
  const lastCol = columnLetter(Math.max(cols.length - 1, 0));
  const colsXml = cols.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(w, 60)}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<dimension ref="A1:${lastCol}${r}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    colsXml +
    `<sheetData>${rowsXml.join('')}</sheetData>` +
    (cols.length ? `<autoFilter ref="A1:${lastCol}${r}"/>` : '') +
    `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>` +
    `</worksheet>`;
  return { xml, rowCount: r - 1 };
}

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts>` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>` +
  `<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font></fonts>` +
  `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/><bgColor indexed="64"/></patternFill></fill></fills>` +
  `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>` +
  `<border><left/><right/><top/><bottom style="thin"><color rgb="FF8EA9C1"/></bottom><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="5">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

/** Builds an .xlsx workbook (one tab per sheet) and returns the zipped bytes. */
export function buildWorkbook(sheets: SheetInput[], options: WorkbookOptions = {}): Uint8Array {
  if (sheets.length === 0) throw new Error('A workbook needs at least one sheet');
  const sst = new SharedStrings();
  const taken = new Set<string>();
  const names = sheets.map((s) => sanitizeSheetName(s.name, taken));
  const files: Zippable = {};
  const sheetFiles = sheets.map((s, i) => sheetXml({ ...s, name: names[i]! }, sst));

  const now = (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const sheetOverrides = sheets
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('');
  files['[Content_Types].xml'] = utf8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      sheetOverrides +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
      `</Types>`,
  );
  files['_rels/.rels'] = utf8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
      `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>` +
      `</Relationships>`,
  );
  files['docProps/core.xml'] = utf8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<dc:title>${xmlEscape(options.title ?? 'Helpdesk Power Suite Export')}</dc:title>` +
      `<dc:creator>${xmlEscape(options.creator ?? 'Helpdesk Power Suite')}</dc:creator>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
      `</cp:coreProperties>`,
  );
  files['docProps/app.xml'] = utf8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Helpdesk Power Suite</Application></Properties>`,
  );
  files['xl/workbook.xml'] = utf8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="16000"/></bookViews>` +
      `<sheets>${names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
      `<definedNames>${sheets
        .map((s, i) => {
          if (!s.columns.length) return '';
          const ref = `'${names[i]!.replace(/'/g, "''")}'!$A$1:$${columnLetter(s.columns.length - 1)}$${sheetFiles[i]!.rowCount + 1}`;
          return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xmlEscape(ref)}</definedName>`;
        })
        .join('')}</definedNames>` +
      `</workbook>`,
  );
  const n = sheets.length;
  files['xl/_rels/workbook.xml.rels'] = utf8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('') +
      `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
      `</Relationships>`,
  );
  sheetFiles.forEach((sf, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = utf8(sf.xml)));
  files['xl/styles.xml'] = utf8(STYLES_XML);
  files['xl/sharedStrings.xml'] = utf8(sst.toXml());

  const mtime = options.now ?? new Date('2024-01-01T00:00:00Z');
  return zipSync(files, { level: 6, mtime });
}
