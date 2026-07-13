export interface PhotoMeta {
  /** ISO date, YYYY-MM-DD */
  date: string | null;
  /** time of day, HH:MM or HH:MM:SS; defaults to 12:00:00 */
  time?: string | null;
  description: string | null;
}

/**
 * Build an XMP sidecar document (exiftool-style layout: one rdf:Description
 * block per namespace) carrying the photo's date and description.
 */
export function buildXmpSidecar(meta: PhotoMeta): string {
  const blocks: string[] = [];
  if (meta.date) {
    const time = normalizeTime(meta.time);
    const dt = `${meta.date}T${time}${amsterdamOffset(meta.date, time)}`;
    blocks.push(` <rdf:Description rdf:about=''
  xmlns:exif='http://ns.adobe.com/exif/1.0/'>
  <exif:DateTimeOriginal>${dt}</exif:DateTimeOriginal>
 </rdf:Description>`);
    blocks.push(` <rdf:Description rdf:about=''
  xmlns:photoshop='http://ns.adobe.com/photoshop/1.0/'>
  <photoshop:DateCreated>${dt}</photoshop:DateCreated>
 </rdf:Description>`);
  }
  if (meta.description) {
    blocks.push(` <rdf:Description rdf:about=''
  xmlns:dc='http://purl.org/dc/elements/1.1/'>
  <dc:description>
   <rdf:Alt>
    <rdf:li xml:lang='x-default'>${esc(meta.description)}</rdf:li>
   </rdf:Alt>
  </dc:description>
 </rdf:Description>`);
  }
  return `<?xpacket begin='﻿' id='W5M0MpCehiHzreSzNTczkc9d'?>
<x:xmpmeta xmlns:x='adobe:ns:meta/' x:xmptk='photo-rectifier'>
<rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>

${blocks.join('\n\n')}
</rdf:RDF>
</x:xmpmeta>
<?xpacket end='w'?>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function normalizeTime(time: string | null | undefined): string {
  if (!time || !/^\d{2}:\d{2}(:\d{2})?$/.test(time)) return '12:00:00';
  return time.length === 5 ? `${time}:00` : time;
}

/** Timezone offset of Europe/Amsterdam at the given moment (CET/CEST aware). */
function amsterdamOffset(date: string, time: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Amsterdam',
      timeZoneName: 'longOffset',
    }).formatToParts(new Date(`${date}T${time}`));
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = name.match(/GMT([+-]\d{2}:\d{2})/);
    if (m) return m[1];
  } catch {
    // fall through to the CET default
  }
  return '+01:00';
}
