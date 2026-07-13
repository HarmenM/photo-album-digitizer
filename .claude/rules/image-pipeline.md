# Image pipeline & canvas rules

## Coordinate systems — be explicit which one you're in

- **Image pixels**: full-resolution source image; corners are stored in image
  pixels of the *rotated* image.
- **CSS pixels**: the fitted editor canvas; `viewScale` converts image → CSS.
- **Device pixels**: canvas backing stores are sized `CSS × devicePixelRatio`.
  When (re)sizing a canvas, always set **both** `width` and `height` and compare
  both — a fresh canvas defaults to 300×150, which equals `150 × dpr` in width
  on retina and has caused a real bug (squashed loupe, off-center crosshair).

## Multi-rectangle editing model

- An image holds many photo rectangles: `quads()` (list of 4-point quads, image
  coordinates), `draft()` (0–3 manually clicked corners of the next quad), and
  `activeIdx()` (which quad is editable). Handles, shrink, correct-boundaries
  and Delete apply to the active quad only; clicking inside an inactive quad
  activates it (smallest containing quad wins so overlaps stay reachable).
- `sortCorners` orders TL, TR, BR, BL only when needed (hit-testing, drawing,
  warping); the raw point order inside each quad is preserved during drags.
- Rotation is quarter turns (0/90/180/270) stored per queue item; quads and
  rotation persist per item across image switches, auto-detect runs only on
  first visit. The drawer thumbnail shows a count badge (bottom-left) with the
  number of rectangles.
- Apply warps EVERY quad; the result step then shows the rectified photos one
  at a time ("photo i / n"), each with its own metadata and its own
  PNG + XMP download (`-1`, `-2`, … suffixes when there are several).
- Interaction thresholds are deliberate: `HIT_RADIUS_CSS_PX = 16` for grabbing,
  4 px click-vs-drag threshold for panning. Don't change them casually.

## Multi-photo detection (detectPhotoRects)

`detectPhotoRects` in `corner-detect.ts` finds all photos on a page. Per
region: **luminance threshold** — Rec. 601 luminance
(`0.299R + 0.587G + 0.114B`) on a ≤ 600 px downscale, 5-tap-Gaussian
blurred, then hard-thresholded exactly like a Photoshop Threshold
adjustment layer: darker = "photo", brighter = page background. The default
level is 153 (`0.6 × 255`), which the user validated with an actual
Photoshop threshold layer on real album pages; thresholding replaced a
fragile estimate-the-background-color approach — don't reintroduce
background estimation without that kind of evidence. The level is chosen
**by the user, not by the code**: repeated `D` presses / Detect clicks
re-run detection while cycling 0.6 → 0.7 → 0.8 → 0.9 (the cycle resets to
0.6 after 2 s of no press or on a photo switch; first-visit auto-detection
always uses 0.6). A higher level keeps light photo content (sky, white
borders) from being trimmed off the crop. Automatic level selection was
tried and **reverted**: neither "best score" (component area ×
rectangularity²) nor "highest level with the highest rectangle count, all
levels scanned" survived real pages — a photo nearly filling its album page
is indistinguishable from a flooded threshold by geometry alone, so every
heuristic mis-picked on some page. Don't reintroduce auto-selection without
per-level ground truth over a corpus of real pages →
dilate + fill enclosed holes smaller than one photo (photo content matching
the page brightness must not fragment the photo, but the page enclosed by a
dark table frame is also "a hole" and must NOT be filled) → erode (net
shrink splits touching photos) → connected components → quad per component
from its diagonal extremes → components that don't fit are eroded in
isolation up to 4 more times and their pieces re-fitted (breaks photos
bridged to page edges by shadows) → keep only rectangul-ish quads (component
fills 72–120% of its quad) covering ≥ 10% of the image, with side aspect
≤ 3.5 (strips along page edges are not photos) → greedily drop quads whose
area lies > 50% inside a bigger accepted one (covers "no photos inside
photos"). Known limitation: photos on *dark* pages read as one blob.

It is **two-level**: the pipeline runs on the whole frame first; when that
yields a single dominant quad (≥ 55% of the image) that quad is the album
page itself, and the pipeline reruns inside it. This is what separates
photos glued on a page from the page — don't flatten it back to one pass.

Segmentation is **discovery only** — its quads are coarse (blob extremes +
morphology slop). Every discovered quad is re-fitted by `houghRefit`: crop
the photo plus a small margin from the full-res image, run the Hough
line-pair fit (`houghQuad`, shared with `detectPageCorners`) guided to the
candidate quad with the best IoU against the coarse one (≥ 0.6, else keep
the coarse quad). This keeps single-photo precision identical to the
original page detector — don't ship segmentation quads directly. Guided
candidates poking more than ~2% outside the coarse quad's bbox are rejected:
segmentation overshoots outward, so the true edge is always inside, and a
soft print shadow can erase a photo's own edge line from the Hough peaks —
without the constraint the fit latches onto the page edge behind the photo
(a real bug, ~70 px overshoot).

**The threshold decides WHICH rectangles exist; it does not place the final
edges.** Edge placement is owned by two later, gradient/contrast-based
stages: `houghRefit` (strongest straight contrast lines, guided by the
threshold quad as above) and, on first visit, `snapCornersToEdges` +
5 px inward shrink. So when detection "looks off" — rectangles sitting
beside the true photo edge — the threshold stage is usually fine and the
deviation comes from refit/snap latching onto a stronger contrast line
nearby; debug those stages (and their guide/IoU constraints) before
touching the threshold.

Diagonal-extremes fitting assumes photos are roughly upright — perspective
morph is fine, heavy rotation is not. `autoDetect` falls back to the
single-page Hough detector (`detectPageCorners`) when segmentation finds
nothing.

(Two detection aids were tried and removed: a user-picked background
eyedropper, and a `DEBUG_DOWNLOAD_MASK` switch that downloaded each region's
eroded mask as a PNG. Both predate the initial git commit, so they are NOT
in history — reimplement from scratch if ever needed again. The mask
downloader is trivial: blit the `mask` array to a canvas and `toBlob` it.)

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
levels) stays put. It operates on ONE rectangle (the active one). Trigger
policy (keep it):

- First visit of an image runs the intricate flow on every detected
  rectangle: auto-detect → snap corners → shrink 5 px inward (so the default
  crop carries no background sliver).
- The `D` shortcut / "Detect photos" button runs the plain detection only.
- Snap also runs on a rectangle completed by the fourth manual corner click,
  and via the `C` shortcut / "Correct boundaries" button — but **never after
  a manual corner drag** (the loupe exists for deliberate placement; snapping
  would fight it).

## Warping

`warpPerspective` in `homography.ts` does the full-resolution bicubic warp in
chunks and reports progress (0..1) so the UI can show a progress bar; keep it
pure and chunked (it runs on the main thread).
