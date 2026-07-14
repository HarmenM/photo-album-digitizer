export interface ZipEntry {
  name: string;
  data: Uint8Array<ArrayBuffer>;
  /** becomes the extracted file's modified (and, on APFS, creation) time */
  mtime: Date;
}

/**
 * Minimal ZIP writer, STORE only (the entries are JPEGs — deflate would buy
 * nothing). It exists for its timestamps: a plain browser download cannot
 * set file dates, but ZIP entries carry them and extractors restore them.
 * Each entry gets two timestamp encodings:
 *
 * - the classic DOS date/time (local time, 2 s resolution, cannot represent
 *   years before 1980 — those clamp to 1980-01-01). macOS `ditto` / Finder's
 *   Archive Utility restore mtime AND creation time from this field;
 * - the extended timestamp extra field (0x5455, signed 32-bit Unix time),
 *   which Info-ZIP `unzip` prefers — that one is exact even before 1980.
 */
export function buildZip(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const { date, time } = dosDateTime(e.mtime);
    const crc = crc32(e.data);
    // extended timestamp: flags = 1 (mtime only) + the Unix time
    const extra = new Uint8Array(9);
    const xv = new DataView(extra.buffer);
    xv.setUint16(0, 0x5455, true);
    xv.setUint16(2, 5, true);
    extra[4] = 1;
    xv.setInt32(5, Math.floor(e.mtime.getTime() / 1000), true);

    const local = new Uint8Array(30 + name.length + extra.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header
    lv.setUint16(4, 20, true); // version needed to extract
    lv.setUint16(6, 0x0800, true); // names are UTF-8
    lv.setUint16(8, 0, true); // STORE
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.data.length, true); // compressed == uncompressed
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, extra.length, true);
    local.set(name, 30);
    local.set(extra, 30 + name.length);
    chunks.push(local, e.data);

    const cen = new Uint8Array(46 + name.length + extra.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory header
    cv.setUint16(4, (3 << 8) | 20, true); // made by Unix, so attrs apply
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, extra.length, true);
    cv.setUint32(38, 0o100644 << 16, true); // external attrs: -rw-r--r--
    cv.setUint32(42, offset, true);
    cen.set(name, 46);
    cen.set(extra, 46 + name.length);
    central.push(cen);
    offset += local.length + e.data.length;
  }
  const cenSize = central.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cenSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cenSize + 22);
  let p = 0;
  for (const c of [...chunks, ...central, eocd]) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/** DOS date/time words (local time); years before 1980 clamp to 1980-01-01. */
function dosDateTime(d: Date): { date: number; time: number } {
  if (d.getFullYear() < 1980) return { date: (1 << 5) | 1, time: 0 };
  return {
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
