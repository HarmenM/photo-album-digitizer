# Image pipeline & canvas rules

## Coordinate systems — be explicit which one you're in

- **Image pixels**: full-resolution source image; corners are stored in image
  pixels of the *rotated* image.
- **CSS pixels**: the fitted editor canvas; `viewScale` converts image → CSS.
- **Device pixels**: canvas backing stores are sized `CSS × devicePixelRatio`.
  When (re)sizing a canvas, always set **both** `width` and `height` and compare
  both — a fresh canvas defaults to 300×150, which equals `150 × dpr` in width
  on retina and has caused a real bug (squashed loupe, off-center crosshair).

## Corner editing model

- `corners()` holds up to 4 points in image coordinates; `sortCorners` orders
  them TL, TR, BR, BL only when needed (hit-testing and warping), the raw array
  order is preserved during drags.
- Rotation is quarter turns (0/90/180/270) stored per queue item; corners and
  rotation persist per item across image switches, auto-detect runs only on
  first visit.
- Interaction thresholds are deliberate: `HIT_RADIUS_CSS_PX = 16` for grabbing,
  4 px click-vs-drag threshold for panning. Don't change them casually.

## Corner detection tuning (corner-detect.ts)

Hough votes are restricted to ±20° around each edge pixel's gradient normal,
which creates "ridge ghost" peaks. This is countered by the 0.45×group-max vote
filter, outermost-pair-first selection, and the near-parallel pair constraint.
These three measures work together — don't remove one without re-testing
detection on real photobook pages.

## Boundary correction (snapCornersToEdges)

`snapCornersToEdges` in `corner-detect.ts` snaps each corner to the photo's
contrast boundary within a 50 px box (±25 px), at full resolution: each of the
corner's two adjacent quad edges slides along its normal to the offset with
the strongest mean contrast step, and the corner becomes the intersection of
the two shifted lines. A corner with no decisive edge (mean step < 12 gray
levels) stays put. Trigger policy (keep it):

- First visit of an image runs the intricate flow: auto-detect → snap corners
  → shrink 5 px inward (so the default crop carries no background sliver).
- The `D` shortcut / "Detect corners" button runs the plain detection only.
- Snap also runs after the fourth manual corner click and via the `C`
  shortcut / "Correct boundaries" button — but **never after a manual corner
  drag** (the loupe exists for deliberate placement; snapping would fight it).

## Warping

`warpPerspective` in `homography.ts` does the full-resolution bicubic warp in
chunks and reports progress (0..1) so the UI can show a progress bar; keep it
pure and chunked (it runs on the main thread).
