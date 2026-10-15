import { strFromU8, unzipSync } from 'fflate';

/** Unzips an .xlsx and returns its parts as strings. */
export function unzipXlsx(bytes: Uint8Array): Record<string, string> {
  const files = unzipSync(bytes);
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
}

/** Tiny XML well-formedness checker (balanced tags, legal chars, single root). Throws on error. */
export function assertWellFormedXml(xml: string, name = 'xml') {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml)) throw new Error(`${name}: illegal control character`);
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>|&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g;
  let m: RegExpExecArray | null;
  let roots = 0;
  while ((m = re.exec(body))) {
    if (m[0].startsWith('&')) throw new Error(`${name}: unescaped & at ${m.index}`);
    const [, close, tag, , self] = m;
    if (close) {
      const open = stack.pop();
      if (open !== tag) throw new Error(`${name}: </${tag}> closes <${open}>`);
    } else if (!self) {
      if (stack.length === 0) roots++;
      stack.push(tag!);
    } else if (stack.length === 0) roots++;
  }
  if (stack.length) throw new Error(`${name}: unclosed <${stack.join('><')}>`);
  if (roots !== 1) throw new Error(`${name}: expected exactly one root element, got ${roots}`);
}

/** Reads cell values of a worksheet as a 2D array of strings (resolving shared strings). */
export function readSheet(parts: Record<string, string>, sheetIndex = 1): string[][] {
  const sst = [...(parts['xl/sharedStrings.xml'] ?? '').matchAll(/<si><t[^>]*>([\s\S]*?)<\/t><\/si>/g)].map((m) => unescape(m[1]!));
  const sheet = parts[`xl/worksheets/sheet${sheetIndex}.xml`]!;
  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<row r="(\d+)">([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const cm of rm[2]!.matchAll(/<c r="([A-Z]+)\d+"([^>]*)><v>([^<]*)<\/v><\/c>/g)) {
      const col = colIndex(cm[1]!);
      const attrs = cm[2]!;
      const v = cm[3]!;
      row[col] = attrs.includes('t="s"') ? sst[Number(v)]! : v;
    }
    rows[Number(rm[1]) - 1] = Array.from(row, (x) => x ?? '');
  }
  return rows;
}

const colIndex = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
