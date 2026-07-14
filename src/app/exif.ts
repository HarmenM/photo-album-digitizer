const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  // Dutch
  januari: 1,
  februari: 2,
  maart: 3,
  mei: 5,
  juni: 6,
  juli: 7,
  augustus: 8,
  oktober: 10,
};

/**
 * Parse a spoken/free-form date like "12 May 2019", "may 12 2019",
 * "12 mei 2019" or "12/05/2019" into a Date. Returns null when no
 * plausible date is found.
 */
export function parseSpokenDate(text: string): Date | null {
  const t = text.toLowerCase().replace(/[.,/\-]/g, ' ');
  const yearMatch = t.match(/\b(19|20)\d{2}\b/);
  if (!yearMatch) return null;
  const year = +yearMatch[0];

  let month: number | null = null;
  for (const [name, m] of Object.entries(MONTHS)) {
    if (new RegExp(`\\b${name}\\b`).test(t)) {
      month = m;
      break;
    }
  }

  const nums = [...t.matchAll(/\b\d{1,2}\b/g)].map((m) => +m[0]);
  let day: number | undefined;
  if (month !== null) {
    day = nums.find((n) => n >= 1 && n <= 31);
  } else if (nums.length >= 2) {
    // numeric form: assume day month year order ("12 05 2019")
    [day, month] = [nums[0], nums[1]];
  }
  if (!day || !month || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day, 12, 0, 0);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Minimal EXIF reader: extracts only the capture date of a JPEG.
 * Looks for DateTimeOriginal (0x9003), then DateTimeDigitized (0x9004) in the
 * Exif sub-IFD, then plain DateTime (0x0132) in IFD0.
 */
export function readExifDate(buf: ArrayBuffer): Date | null {
  try {
    const view = new DataView(buf);
    if (view.byteLength < 12 || view.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 <= view.byteLength) {
      const marker = view.getUint16(off);
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break; // start of scan
      const size = view.getUint16(off + 2);
      if (
        marker === 0xffe1 &&
        size >= 10 &&
        view.getUint32(off + 4) === 0x45786966 && // "Exif"
        view.getUint16(off + 8) === 0
      ) {
        const date = parseTiff(view, off + 10);
        if (date) return date;
      }
      off += 2 + size;
    }
  } catch {
    // truncated/corrupt metadata — treat as "no date"
  }
  return null;
}

function parseTiff(view: DataView, base: number): Date | null {
  const little = view.getUint16(base) === 0x4949; // "II"
  const u16 = (o: number) => view.getUint16(base + o, little);
  const u32 = (o: number) => view.getUint32(base + o, little);
  if (u16(2) !== 42) return null;

  // returns tag -> offset (relative to base) of the 12-byte IFD entry
  const readIfd = (ifdOff: number, wanted: number[]): Map<number, number> => {
    const found = new Map<number, number>();
    const n = u16(ifdOff);
    for (let i = 0; i < n; i++) {
      const e = ifdOff + 2 + i * 12;
      const tag = u16(e);
      if (wanted.includes(tag)) found.set(tag, e);
    }
    return found;
  };

  const asciiValue = (entry: number): string | null => {
    const type = u16(entry + 2);
    const count = u32(entry + 4);
    if (type !== 2 || count < 9 || count > 64) return null;
    const valOff = count > 4 ? u32(entry + 8) : entry + 8;
    let s = '';
    for (let i = 0; i < count - 1; i++) {
      const ch = view.getUint8(base + valOff + i);
      if (!ch) break;
      s += String.fromCharCode(ch);
    }
    return s;
  };

  let dateStr: string | null = null;
  const ifd0 = readIfd(u32(4), [0x8769, 0x0132]);
  const exifPtr = ifd0.get(0x8769);
  if (exifPtr !== undefined && u16(exifPtr + 2) === 4) {
    const exifIfd = readIfd(u32(exifPtr + 8), [0x9003, 0x9004]);
    const entry = exifIfd.get(0x9003) ?? exifIfd.get(0x9004);
    if (entry !== undefined) dateStr = asciiValue(entry);
  }
  if (!dateStr) {
    const entry = ifd0.get(0x0132);
    if (entry !== undefined) dateStr = asciiValue(entry);
  }
  if (!dateStr) return null;

  // "YYYY:MM:DD HH:MM:SS"
  const m = dateStr.match(/^(\d{4}):(\d{2}):(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h = '12', mi = '0', s = '0'] = m;
  const date = new Date(+y, +mo - 1, +d, +h, +mi, +s);
  return isNaN(date.getTime()) ? null : date;
}

// --- EXIF writer: the mirror of the reader above --------------------------

export interface ExifMeta {
  /** ISO date, YYYY-MM-DD */
  date: string | null;
  /** time of day, HH:MM or HH:MM:SS; defaults to 12:00:00 */
  time?: string | null;
  /** timezone offset for the date, ±HH:MM (written as OffsetTimeOriginal) */
  offset?: string | null;
  description?: string | null;
}

const TIFF_ASCII = 2;
const TIFF_LONG = 4;

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  data: Uint8Array; // raw value bytes; > 4 bytes moves to the value area
}

/**
 * Splice an EXIF APP1 segment into a bare JPEG (canvas.toBlob output carries
 * no metadata at all), directly after the SOI marker. Writes
 * DateTimeOriginal + OffsetTimeOriginal into the Exif sub-IFD and
 * ImageDescription into IFD0. The description is UTF-8 — the EXIF spec says
 * ASCII, but UTF-8 is the de-facto convention exiftool and the major photo
 * apps read. Returns the input unchanged when there is nothing to write or
 * the buffer is not a JPEG.
 */
export function embedExifJpeg(
  jpeg: Uint8Array<ArrayBuffer>,
  meta: ExifMeta,
): Uint8Array<ArrayBuffer> {
  if (!meta.date && !meta.description) return jpeg;
  if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  const app1 = buildExifApp1(meta);
  const out = new Uint8Array(jpeg.length + app1.length);
  out.set(jpeg.subarray(0, 2));
  out.set(app1, 2);
  out.set(jpeg.subarray(2), 2 + app1.length);
  return out;
}

/** NUL-terminated ASCII/UTF-8 TIFF value. */
function asciiBytes(text: string): Uint8Array {
  const raw = new TextEncoder().encode(text);
  const data = new Uint8Array(raw.length + 1); // trailing NUL
  data.set(raw);
  return data;
}

function buildExifApp1(meta: ExifMeta): Uint8Array {
  const ifd0: IfdEntry[] = [];
  const exifIfd: IfdEntry[] = [];
  if (meta.description) {
    const data = asciiBytes(meta.description);
    ifd0.push({ tag: 0x010e, type: TIFF_ASCII, count: data.length, data });
  }
  if (meta.date) {
    const time =
      meta.time && /^\d{2}:\d{2}(:\d{2})?$/.test(meta.time)
        ? meta.time.length === 5
          ? `${meta.time}:00`
          : meta.time
        : '12:00:00';
    const dt = asciiBytes(`${meta.date.replace(/-/g, ':')} ${time}`);
    exifIfd.push({ tag: 0x9003, type: TIFF_ASCII, count: dt.length, data: dt });
    if (meta.offset && /^[+-]\d{2}:\d{2}$/.test(meta.offset)) {
      const off = asciiBytes(meta.offset);
      exifIfd.push({ tag: 0x9011, type: TIFF_ASCII, count: off.length, data: off });
    }
  }
  // pointer to the Exif sub-IFD; its value is filled in after the layout
  const exifPtr: IfdEntry | null = exifIfd.length
    ? { tag: 0x8769, type: TIFF_LONG, count: 1, data: new Uint8Array(4) }
    : null;
  if (exifPtr) ifd0.push(exifPtr);
  ifd0.sort((a, b) => a.tag - b.tag); // IFD entries must be tag-ordered

  // layout, all offsets relative to the TIFF header: header (8) -> IFD0 ->
  // Exif IFD -> value area for entries wider than the 4 inline bytes
  const ifdSize = (n: number) => 2 + n * 12 + 4;
  const exifIfdOffset = 8 + ifdSize(ifd0.length);
  const valueStart = exifIfdOffset + (exifIfd.length ? ifdSize(exifIfd.length) : 0);
  if (exifPtr) new DataView(exifPtr.data.buffer).setUint32(0, exifIfdOffset);
  const valueOffsets = new Map<IfdEntry, number>();
  let valueEnd = valueStart;
  for (const e of [...ifd0, ...exifIfd]) {
    if (e.data.length > 4) {
      valueOffsets.set(e, valueEnd);
      valueEnd += e.data.length + (e.data.length & 1); // keep offsets even
    }
  }

  const tiff = new Uint8Array(valueEnd);
  const view = new DataView(tiff.buffer);
  tiff.set([0x4d, 0x4d, 0x00, 0x2a]); // "MM", big-endian TIFF
  view.setUint32(4, 8); // IFD0 offset
  const writeIfd = (entries: IfdEntry[], at: number) => {
    view.setUint16(at, entries.length);
    let p = at + 2;
    for (const e of entries) {
      view.setUint16(p, e.tag);
      view.setUint16(p + 2, e.type);
      view.setUint32(p + 4, e.count);
      if (e.data.length > 4) view.setUint32(p + 8, valueOffsets.get(e)!);
      else tiff.set(e.data, p + 8); // inline, zero-padded
      p += 12;
    }
    view.setUint32(p, 0); // no next IFD
  };
  writeIfd(ifd0, 8);
  if (exifIfd.length) writeIfd(exifIfd, exifIfdOffset);
  for (const [e, off] of valueOffsets) tiff.set(e.data, off);

  // wrap as an APP1 segment: FF E1, length (excl. marker), "Exif\0\0", TIFF
  const seg = new Uint8Array(4 + 6 + tiff.length);
  const segView = new DataView(seg.buffer);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  segView.setUint16(2, seg.length - 2);
  seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4); // "Exif\0\0"
  seg.set(tiff, 10);
  return seg;
}
