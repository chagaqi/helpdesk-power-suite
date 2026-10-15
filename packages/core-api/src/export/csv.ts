import type { Primitive } from '../types.js';
import type { ColumnSpec } from './columns.js';

export interface CsvOptions {
  /** Field delimiter. Use ";" for Excel installs with a comma decimal separator. */
  delimiter?: ',' | ';' | '\t';
  /** Prefix a UTF-8 byte-order mark so Excel opens non-ASCII text correctly. Default true. */
  bom?: boolean;
  /** Neutralize spreadsheet formula injection (cells starting with = + - @ TAB CR). Default true. */
  sanitizeFormulas?: boolean;
  /** Line terminator. RFC 4180 uses CRLF (default). */
  eol?: '\r\n' | '\n';
}

export const UTF8_BOM = '﻿';
const FORMULA_START = /^[=+\-@\t\r]/;

export function formatCsvCell(value: Primitive, kind: ColumnSpec['kind'], o: Required<CsvOptions>): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (typeof value === 'boolean') text = value ? 'TRUE' : 'FALSE';
  else if (typeof value === 'number') text = Number.isFinite(value) ? String(value) : '';
  else {
    text = value;
    // Numbers/dates typed as such are safe; only free text can smuggle a formula.
    if (o.sanitizeFormulas && FORMULA_START.test(text) && !(kind === 'number' && /^-?\d+(\.\d+)?$/.test(text))) {
      text = `'${text}`;
    }
  }
  const needsQuote =
    text.includes('"') || text.includes(o.delimiter) || text.includes('\n') || text.includes('\r') || /^\s|\s$/.test(text);
  return needsQuote ? `"${text.replace(/"/g, '""')}"` : text;
}

const withDefaults = (o: CsvOptions = {}): Required<CsvOptions> => ({
  delimiter: o.delimiter ?? ',',
  bom: o.bom ?? true,
  sanitizeFormulas: o.sanitizeFormulas ?? true,
  eol: o.eol ?? '\r\n',
});

/**
 * Yields CSV text chunks (header first) so large exports can be streamed without
 * materializing one giant string. `rowsPerChunk` rows are joined per chunk.
 */
export function* csvChunks(
  columns: ColumnSpec[],
  rows: Iterable<Primitive[]>,
  options?: CsvOptions,
  rowsPerChunk = 500,
): Generator<string> {
  const o = withDefaults(options);
  const header = columns.map((c) => formatCsvCell(c.label, 'string', o)).join(o.delimiter) + o.eol;
  yield (o.bom ? UTF8_BOM : '') + header;
  let buf: string[] = [];
  for (const row of rows) {
    buf.push(columns.map((c, i) => formatCsvCell(row[i] ?? null, c.kind, o)).join(o.delimiter));
    if (buf.length >= rowsPerChunk) {
      yield buf.join(o.eol) + o.eol;
      buf = [];
    }
  }
  if (buf.length) yield buf.join(o.eol) + o.eol;
}

export const toCsv = (columns: ColumnSpec[], rows: Iterable<Primitive[]>, options?: CsvOptions): string =>
  Array.from(csvChunks(columns, rows, options)).join('');

/** Minimal RFC 4180 parser (used by tests and by the playground to verify round-trips). */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const src = text.startsWith(UTF8_BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && src[i + 1] === '\n') {
      // handled by \n branch
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
