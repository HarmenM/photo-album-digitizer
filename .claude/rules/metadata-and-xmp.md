# Metadata, dates & XMP

- Saving produces a PNG plus an XMP sidecar built by `buildXmpSidecar`
  (`xmp.ts`): exiftool-style layout with one `rdf:Description` block per
  namespace — `exif:DateTimeOriginal`, `photoshop:DateCreated`, and
  `dc:description`. Keep that block-per-namespace shape; downstream tooling
  expects it.
- Timestamps get a **Europe/Amsterdam** offset computed via `Intl` (CET/CEST
  depending on the date), not the machine's zone.
- Date/time UI defaults: date empty, time `12:00:00`. There is deliberately no
  EXIF UI — the EXIF capture moment (parsed in `exif.ts`) is used silently as
  fallback only when the date field is left empty.
- Scratchpad (`ScratchEntry`) is shared across the queue and persisted in
  `localStorage` under `photo-rectifier.scratchpad`. Date chips track a `used`
  count; each application stamps `12:00:00` plus `used` seconds so repeated use
  of the same date yields distinct timestamps. Preserve this scheme.
- Voice dictation (Web Speech API, Chrome-only) is for descriptions only; dates
  are typed or auto-classified by the parser in `exif.ts`, which accepts
  English and Dutch month names.
