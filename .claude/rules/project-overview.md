# Project overview

Photo Rectifier is a single-page Angular 22 app that batch-rectifies photographed
photobook pages: pick/drag in a queue of photos, mark the four page corners
(auto-detected, then adjustable), warp to a flat rectangle, add date/description
metadata, and save a PNG plus an XMP sidecar. Some pages are "info" pages: not
saved, but their dates/descriptions go into a shared scratchpad reused as
clickable chips on later photos.

## Layout

Everything lives in `src/app/`:

- `app.ts` / `app.html` / `app.css` — the single `App` component: queue, corner
  editor canvas, precision loupe, result/info views, scratchpad, keyboard
  shortcuts, voice dictation. All UI state is here as signals.
- `corner-detect.ts` — automatic page-corner detection (gradient + Hough-style
  line voting). Pure functions, no Angular.
- `homography.ts` — `Point`, corner sorting, quad inset, homography computation,
  full-resolution bicubic perspective warp. Pure functions.
- `exif.ts` — EXIF date extraction from JPEG APP1, spoken/typed date parsing
  (English + Dutch month names). Pure functions.
- `xmp.ts` — XMP sidecar builder (exiftool-style layout). Pure functions.

Keep this split: `app.ts` orchestrates; image/metadata algorithms stay in the
pure helper modules where they can be tested without a DOM.

## Caveats

- This project is intentionally **not a git repository**. Don't suggest git
  commands or try to commit; there is no history to consult.
- `dist/` is build output — never edit or grep it for answers.
