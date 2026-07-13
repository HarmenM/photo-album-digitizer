const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  // Dutch
  januari: 1, februari: 2, maart: 3, mei: 5, juni: 6,
  juli: 7, augustus: 8, oktober: 10,
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
