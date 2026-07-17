# Metadata, dates & EXIF/XMP

- Saving produces a **JPEG (quality from settings, default 0.95) with the
  metadata embedded as real EXIF**: canvas encoders emit bare JPEGs, so
  `embedExifJpeg` (`exif.ts`, the mirror of the EXIF reader in the same
  module) splices an APP1 segment in after SOI — `DateTimeOriginal` +
  `OffsetTimeOriginal` in the Exif sub-IFD, `ImageDescription` (UTF-8; the
  spec says ASCII but UTF-8 is the de-facto convention) in IFD0. No metadata
  entered → plain JPEG, no EXIF.
- **Settings** (cogwheel in the toolbars, persisted in `localStorage` under
  `photo-album-digitizer.settings`): JPG quality (0.5–1), the filename suffix
  (default `-result`, sanitized of path/forbidden characters, may be empty),
  the download style — `single` (every save downloads its JPG directly)
  or `zip` (saves collect into the batch ZIP; nothing downloads until the
  ZIP button) — and a **require-date** toggle (`dateRequired`, default off).
  The mobile layout (see ui-interactions.md) hides the download-style radios
  and forces direct download: template and `save()` read
  `effectiveDownloadStyle` (mobile ⇒ `'single'`), never `downloadStyle`
  directly, while the persisted setting stays intact for the desktop.
  The persisted settings JSON also carries `defaultPresetId` (see the tune
  presets in ui-interactions.md). In zip mode a re-processed photo never
  overwrites a collected one: `uniqueZipName` appends `-2`, `-3`, … before
  `.jpg`.
- **Require date**: when the setting is on, `save()` refuses a photo whose
  date field is empty (the silent EXIF fallback does not satisfy it) and sets
  `dateError`, shown as a red-outlined date field + "A date is required" in
  the metadata bar. The error clears as soon as a date is typed or another
  photo is shown.
- The XMP sidecar this replaced still exists as `buildXmpSidecar` (`xmp.ts`,
  exiftool-style one-`rdf:Description`-per-namespace layout) — currently
  unused, kept for a possible embedded-XMP or sidecar-compat option.
- Timestamps get a **Europe/Amsterdam** offset computed via `Intl` (CET/CEST
  depending on the date), not the machine's zone — `amsterdamOffset` in
  `xmp.ts` owns that rule for both XMP and EXIF.
- **File dates**: a browser download cannot set a file's created/modified
  time, so the zip download style collects saves into a batch ZIP
  (`buildZip` in `zip.ts`, STORE-only) whose entries are stamped with each
  photo's date — extraction restores it as the file's modified and (APFS)
  creation time. Two encodings per entry, both needed: DOS time (what
  Finder/`ditto` reads; clamps pre-1980 dates to 1980-01-01) and the 0x5455
  extended Unix timestamp (what `unzip` reads; exact even before 1980).
  Verified empirically against both extractors — keep both fields. The
  toolbar ZIP split button downloads the archive; its right segment opens
  the collection page (entries removable there); the done screen offers the
  same download.
- Date/time UI defaults: date empty, time `12:00:00`. There is deliberately no
  EXIF UI — the EXIF capture moment (parsed in `exif.ts`) is used silently as
  fallback only when the date field is left empty.
- Scratchpad (`ScratchEntry`) is shared across the queue and persisted in
  `localStorage` under `photo-album-digitizer.scratchpad`. Date chips track a `used`
  count; each application stamps `12:00:00` plus `used` seconds so repeated use
  of the same date yields distinct timestamps. Preserve this scheme. The
  chips' "+1d" mini-button applies the date shifted one day forward with a
  plain `12:00:00` — a different day needs no disambiguating second — and
  leaves the entry's `used` counter alone.
- Saving feeds back into reuse: hand-entered dates/descriptions are added to
  the scratchpad on save (deduped by ISO date / exact text), and the save's
  field values are remembered for the metadata bar's "use previous" button
  (only saves that carried input; cleared on batch reset).
- Voice dictation (Web Speech API, Chrome-only) is for descriptions only; dates
  are typed or auto-classified by the parser in `exif.ts`, which accepts
  English and Dutch month names. It is a **dictaphone toggle**: a mic press
  starts recording (`continuous` recognition, so it does not auto-stop on a
  pause), the next press stops and applies the accumulated transcript. While
  recording, both mic buttons show a red pulsing `stop` icon labeled "Stop
  recording"; the status chip previews interim words. `dictate()` toggles,
  `startDictation()`/`stopDictation()`/`finishDictation()` do the work.
  Push-to-talk (hold to record, release to apply) was tried and reverted: the
  Web Speech API's warm-up after `start()` swallows the first word and the
  cut-off at `stop()` swallows the last whenever the user speaks hastily —
  the toggle sidesteps both because the user naturally waits. `finishDictation`
  still applies `dictationText` (final) **plus** `dictationInterim` (the last
  not-yet-final tail) so stopping never drops trailing words.
- Before the first dictation, if the browser has not yet granted mic access
  (`navigator.permissions` reports anything but `granted`, or the API is
  missing) a **consent modal** explains that some browsers route audio through
  a cloud speech-to-text service, with Cancel / Continue. Continue only
  **acknowledges** (`micConsentAcknowledged`) — it does NOT start recording;
  the user presses the mic again to begin. Cancel/Esc/backdrop dismiss it.
  Once acknowledged (or the permission is already granted) later presses start
  straight away, so the modal never nags again.
