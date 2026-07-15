# Photo Album Digitizer
## Open the App
Check out the [The live Photo Album Digitizer app](https://harmenm.github.io/photo-album-digitizer/) 🖼️.

## Why this? And how I use it myself
I have a whole stack of photo albums I wanted to digitize. The albums hold
several photos per page, with descriptions and dates written next to them. I
photographed every page, and sometimes individual photos as well. This tool
makes sure each photo is cut out neatly, and that its metadata is set right
efficiently: a photo taken in the eighties should carry a date stamp
from the eighties. With the scratchpad I can quickly store the dates and
descriptions written in the album, and later click them together while
processing the individual photos.

Digitize old photo albums with nothing but a camera and a browser. Photograph
your album pages, drop the shots into the app, and it finds every photo on the
page, straightens it, and saves it as a high-quality JPEG with the date and
description embedded as real EXIF metadata. Everything runs locally in the
browser — your photos never leave your machine.

## Features

- **Batch queue** — drop a whole folder of page shots at once; a thumbnail
  drawer tracks progress with saved-checkmarks and per-page photo counts.
- **Automatic photo detection** — finds every photo on an album page
  (adaptive luminance threshold, Hough line refit, contrast-edge snapping),
  with a Reset button to re-run it after manual changes.
- **Precise corner editing** — draggable corners with a full-resolution
  magnifier loupe, midpoint grips to slide whole edges, manual marking for
  photos the detection missed, and progressive boundary correction (`C`)
  that widens its search area on repeated presses (L, XL).
- **Perspective correction** — photos shot at an angle come out perfectly
  flat and rectangular, without losing any sharpness from the original
  shot; rotate pages in quarter turns and the photo numbering follows
  automatically.
- **Photoshop-style tuning** — per-photo levels (RGB master and per
  channel, with a live histogram), brightness and contrast in the side
  panel of the preview step, with a before/after comparison toggle;
  non-destructive until saved, when the adjustments are baked into the
  exported JPEG. Reapply the last settings with one click, or save named
  presets (kept across sessions) and apply them from chips.
- **Per-photo metadata** — date, time, and description per photo; an
  always-visible scratchpad collects dates/descriptions from context pages
  and offers them as one-click chips; voice dictation for
  descriptions (Chrome).
- **EXIF-embedded JPEG export** — `DateTimeOriginal` (with CET/CEST
  timezone offset) and the description are embedded in the file itself; JPG
  quality and the filename suffix are configurable in the settings.
- **Two download styles** — direct download per save, or collect everything
  into one ZIP whose files carry the photo dates as file dates after
  extraction (with a reviewable, removable collection page).
- **Keyboard-first** — every action has a shortcut (see the table below),
  and every shortcut is shown in its button's tooltip.

## Keyboard shortcuts

| Key | Where | Action |
| --- | --- | --- |
| `R` / `L` | editor & preview | Rotate 90° right / left |
| `C` | editor | Correct boundaries of the active rectangle — press again within 2 s to widen the search area (L, then XL) |
| `S` | editor | Shrink the active rectangle 10 px inward |
| `Delete` / `Backspace` | editor | Cancel the rectangle being marked, or else delete the active rectangle |
| `Esc` | editor | Cancel the rectangle being marked |
| `←` / `→` | editor | Previous / next image in the queue |
| `←` / `→` | preview | Previous / next rectified photo |
| `B` | preview | Before/after: toggle the tune preview eye |
| `U` | preview | Apply the last configured tune settings |
| `Ctrl/⌘ + 1`…`5` | preview | Apply tune preset 1–5 (the number shown on the chip) |
| `Alt/⌘ + Enter` | editor & preview | Confirm the current step: Apply, or Save & next (also works while typing) |
| `Esc` / `Backspace` / browser Back | preview | Back to the corner editor (in an input, the first `Esc` leaves the field, the second leaves the screen) |
| `Esc` | settings / ZIP collection | Close the dialog / go back |
| `Ctrl/⌘ + +` / `−` / `0` | editor & preview | Zoom in / out / reset (trackpad pinch zooms too; plain scrolling pans) |

## Development

```bash
npm start        # dev server on http://localhost:4200
npm run build    # production build into dist/photo-album-digitizer
npm test         # unit tests
```

Every push to `main` is built and published to GitHub Pages by
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

Built with Angular (zoneless, signals) and no image or metadata libraries —
the photo detection, perspective warp, EXIF writing, and ZIP packing are
hand-rolled pure TypeScript modules in `src/app/`.

## How this was built

This little project was vibe-coded together: all the code was written in
conversation with [Claude Code](https://claude.com/claude-code), feature by
feature. My side of the loop was describing the workflow I wanted, trying
every change on real album pages, and sending back whatever didn't hold up —
which is also how the detection pipeline got its tuning: threshold levels,
Hough constraints, and snapping behavior were all validated against actual
photographed pages rather than designed up front.

## License

[MIT](LICENSE)
