# Project overview

Photo Rectifier is a single-page Angular 22 app that batch-rectifies photographed
photobook pages: pick/drag in a queue of photos, mark the corners of every photo
on the page (multi-photo auto-detection, then adjustable rectangles), warp each
to a flat rectangle, add date/description metadata per photo, and save a PNG
plus an XMP sidecar for each. A shared scratchpad lives in an always-visible
right side panel: dates/descriptions collected from context pages ("info"
pages, not saved themselves) are reused as clickable chips when saving later
photos.

## Layout

Everything lives in `src/app/`:

- `app.ts` / `app.html` / `app.css` — the single `App` component: queue, corner
  editor canvas, precision loupe, result view, scratchpad panel, keyboard
  shortcuts, voice dictation. All UI state is here as signals.
- `corner-detect.ts` — automatic photo detection: multi-photo segmentation
  (`detectPhotoRects`, luminance threshold + morphology + Hough refit),
  single-page corner detection (`detectPageCorners`, gradient + Hough-style
  line voting), and corner snapping (`snapCornersToEdges`). Pure functions,
  no Angular.
- `homography.ts` — `Point`, corner sorting, quad inset, homography computation,
  full-resolution bicubic perspective warp. Pure functions.
- `exif.ts` — EXIF date extraction from JPEG APP1, spoken/typed date parsing
  (English + Dutch month names). Pure functions.
- `xmp.ts` — XMP sidecar builder (exiftool-style layout). Pure functions.

Keep this split: `app.ts` orchestrates; image/metadata algorithms stay in the
pure helper modules where they can be tested without a DOM.

## Caveats

- This project **is a git repository** (since 2026-07-13; history starts at
  the "Initial commit: Photo Album Digitizer" commit — work before that,
  including tried-and-removed experiments, is not in history). Don't commit
  unless the user asks.
- `dist/` is build output — never edit or grep it for answers.
