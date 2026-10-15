// Minimal dependency-free PNG encoder + logo renderer used to generate marketplace icons.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encodes RGBA pixels (Uint8Array w*h*4) as PNG. */
export function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Renders the Helpdesk Power Suite mark: rounded blue tile, white spreadsheet grid and a bolt. */
export function renderLogo(size) {
  const px = new Uint8Array(size * size * 4);
  const r = size * 0.18;
  const inside = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const s = (v) => v * size;
  const rects = [
    [0.2, 0.24, 0.6, 0.1], [0.2, 0.42, 0.6, 0.06], [0.2, 0.56, 0.6, 0.06], [0.2, 0.7, 0.6, 0.06], [0.42, 0.24, 0.05, 0.52],
  ];
  const bolt = [[0.7, 0.12], [0.56, 0.5], [0.66, 0.5], [0.58, 0.88], [0.86, 0.42], [0.75, 0.42], [0.84, 0.12]];
  const inPoly = (x, y) => {
    let c = false;
    for (let i = 0, j = bolt.length - 1; i < bolt.length; j = i++) {
      const [xi, yi] = bolt[i].map(s);
      const [xj, yj] = bolt[j].map(s);
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inside(x + 0.5, y + 0.5)) continue;
      const t = y / size;
      let rgb = [31 - 10 * t, 115 - 30 * t, 183 - 20 * t];
      if (rects.some(([rx, ry, rw, rh]) => x >= s(rx) && x < s(rx + rw) && y >= s(ry) && y < s(ry + rh))) rgb = [255, 255, 255];
      if (inPoly(x + 0.5, y + 0.5)) rgb = [255, 196, 0];
      px.set([rgb[0], rgb[1], rgb[2], 255], i);
    }
  }
  return encodePng(size, size, px);
}

export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" rx="12" fill="#1f73b7"/><g fill="#fff"><rect x="13" y="15" width="38" height="6"/><rect x="13" y="27" width="38" height="4"/><rect x="13" y="36" width="38" height="4"/><rect x="13" y="45" width="38" height="4"/><rect x="27" y="15" width="3" height="34"/></g><path d="M45 8 36 32h6l-5 24 18-29h-7l6-19z" fill="#ffc400"/></svg>\n`;

/** Monochrome nav-bar icon (Zendesk recolors via currentColor). */
export const NAV_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18"><g fill="currentColor"><rect x="1" y="3" width="11" height="2"/><rect x="1" y="7" width="11" height="1.5"/><rect x="1" y="10.5" width="11" height="1.5"/><rect x="1" y="14" width="11" height="1.5"/><path d="M15.5 1 13 8h2l-1.5 9L18 6.5h-2L17.5 1z"/></g></svg>\n`;
