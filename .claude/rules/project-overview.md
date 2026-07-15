# Project overview

Photo Album Digitizer is a single-page Angular 22 app that batch-rectifies photographed
photobook pages: pick/drag in a queue of photos, mark the corners of every photo
on the page (multi-photo auto-detection, then adjustable rectangles), warp each
to a flat rectangle, add date/description metadata per photo, and save each
as a high-quality JPEG with the metadata embedded as EXIF. A shared
scratchpad lives in an always-visible
right side panel: dates/descriptions collected from context pages ("info"
pages, not saved themselves) are reused as clickable chips when saving later
photos.

## Layout

Everything lives in `src/app/`:

- `app.ts` / `app.html` / `app.css` — the single `App` component: queue, corner
  editor canvas, precision loupe, result view, ZIP-collection page, settings
  modal, scratchpad panel, keyboard shortcuts, voice dictation. All UI state
  is here as signals.
- `corner-detect.ts` — automatic photo detection: multi-photo segmentation
  (`detectPhotoRects`, luminance threshold + morphology + Hough refit),
  single-page corner detection (`detectPageCorners`, gradient + Hough-style
  line voting), and corner snapping (`snapCornersToEdges`). Pure functions,
  no Angular.
- `homography.ts` — `Point`, corner sorting, quad inset, homography computation,
  full-resolution bicubic perspective warp. Pure functions.
- `exif.ts` — EXIF date extraction from JPEG APP1 and its mirror, the EXIF
  APP1 writer used on save; spoken/typed date parsing (English + Dutch month
  names). Pure functions.
- `xmp.ts` — XMP sidecar builder (exiftool-style layout; currently unused)
  and the Europe/Amsterdam timezone-offset rule. Pure functions.
- `tune.ts` — Photoshop-style image tuning for the result screen: input
  levels (master RGB + per channel), legacy brightness/contrast, composed
  into per-channel LUTs; channel histograms. Pure functions.
- `zip.ts` — minimal STORE-only ZIP writer whose entries carry the photo
  dates as file timestamps (the "collect into ZIP" download style). Pure
  functions.

Keep this split: `app.ts` orchestrates; image/metadata algorithms stay in the
pure helper modules where they can be tested without a DOM.

## Caveats

- This project **is a git repository** (since 2026-07-13; history starts at
  the "Initial commit: Photo Album Digitizer" commit — work before that,
  including tried-and-removed experiments, is not in history). Don't commit
  unless the user asks.
- `dist/` is build output — never edit or grep it for answers.
