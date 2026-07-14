# Image pipeline & canvas rules

## Coordinate systems — be explicit which one you're in

- **Image pixels**: full-resolution source image; corners are stored in image
  pixels of the *rotated* image.
- **CSS pixels**: the fitted editor canvas; `viewScale` converts image → CSS.
- **Device pixels**: canvas backing stores are sized `CSS × devicePixelRatio`.
  When (re)sizing a canvas, always set **both** `width` and `height` and compare
  both — a fresh canvas defaults to 300×150, which equals `150 × dpr` in width
  on retina and has caused a real bug (squashed loupe, off-center crosshair).
- When fitting a canvas into its host, measure the host with
  `hostContentSize` (app.ts), not `clientWidth`/`clientHeight` directly —
  those INCLUDE the host's padding, and fitting to them oversizes the canvas
  by exactly the padding (a real bug: permanent scrollbars at zoom 1 on both
  the editor and the preview).

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
  at a time ("photo i / n"), each saved individually as a JPEG with embedded
  EXIF (see metadata-and-xmp.md): `basename` + the configurable filename
  suffix (settings; default `-result`) + `-1`, `-2`, … crop numbers when
  there are several.
- Interaction thresholds are deliberate: `HIT_RADIUS_CSS_PX = 16` for grabbing,
  4 px click-vs-drag threshold for panning. Don't change them casually.

## Multi-photo detection (detectPhotoRects)

`detectPhotoRects` in `corner-detect.ts` finds all photos on a page. Per
region: **luminance threshold** — Rec. 601 luminance
(`0.299R + 0.587G + 0.114B`) on a ≤ 600 px downscale, 5-tap-Gaussian
blurred, then hard-thresholded exactly like a Photoshop Threshold
adjustment layer: darker = "photo", brighter = page background. The base
level is 153 (`0.6 × 255`), which the user validated with an actual
Photoshop threshold layer on real album pages; thresholding replaced a
fragile estimate-the-background-color approach — don't reintroduce
background estimation without that kind of evidence. A higher level keeps
light photo content (sky, white borders) from being trimmed off the crop.
By default the level **climbs** (auto-selection take 3; takes 1 and 2 —
best score, and highest count over all levels — mis-picked on real pages):
segment at 0.6, then repeatedly 0.05 higher up to 0.9, keeping the lowest
step that explains the page. A higher step becomes the new best only when
it **progresses** vs the best step so far — more rectangles resolved, or a
matched rectangle growing ≥ 20% in area (real content was being trimmed) —
without **degrading** it: fewer rectangles (photos merged), a previous
rectangle no longer ≥ 90% inside a new one (blob drifted/fragmented), a
matched rectangle's corner angles further from 90° with 1° slack (shear
creeping in), or any quad swallowing ≥ 97% of the region (the threshold
**flooded** — no page background left; on a real page the flood step,
74% → 99% of the frame, looked containing and rectangular and only this
rule rejects it). A degraded step is **skipped, not a stop**: a blob
absorbing bright photo content can pass through a transient
non-rectangular shape (a real mostly-bright photo segmented wrong at 0.6,
empty at 0.65, and right from 0.7 up — its rectangle then grew 53%, while
stopping at the first degradation kept the wrong 0.6 quad), so a later
level that again beats the best step resumes the climb; merged, drifted
and flooded levels keep failing the same checks and never win. Neutral
steps — the same rectangles a few percent fatter (page shading and
morphology creep, +6% on a real page) — leave the best level alone; that
is what stops the crop drifting past the photo's edges. Every detection —
first visit and the toolbar's Reset alike — uses the climb;
`detectPhotoRects`' explicit-level parameter remains for tests and tuning
(a dedicated Detect button with a fixed-level press cycle used to exist and
was removed once the climb held up on real pages) →
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
yields a single dominant quad (≥ 55% of the image) **whose surround is
mostly dark** (≥ 40% of the pixels outside the quad below the winning
threshold level) that quad is the album page lying on a dark table, and
the pipeline reruns inside it. This is what separates photos glued on a
page from the page — don't flatten it back to one pass. The dark-surround
gate is load-bearing: a photo filling most of the frame is *also* a lone
dominant quad, but its surround is the bright page (measured 1–23% dark on
real pages), and rerunning inside a photo trades the correct crop for
whatever its content happens to segment into (a real photo lost its bright
half that way).

Segmentation is **discovery only** — its quads are coarse (blob extremes +
morphology slop). Every discovered quad is re-fitted by `houghRefit`: crop
the photo plus a small margin from the full-res image, run the Hough
line-pair fit (`houghQuad`, shared with `detectPageCorners`) guided to the
candidate quad with the best IoU against the coarse one (≥ 0.8, else keep
the coarse quad — a true refit only nudges edges by a few percent, and a
lower IoU means the fit collapsed onto strong lines *inside* the photo
because the real edge is too soft to peak: a pale path against the white
page cost a real photo a third of its width at the old 0.6 bar). This
keeps single-photo precision identical to the original page detector —
don't ship segmentation quads directly. Guided
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
contrast boundary within a search box (±25 px by default; callers can widen
it), at full resolution: each of the
corner's two adjacent quad edges slides along its normal to the offset with
the strongest mean contrast step, and the corner becomes the intersection of
the two shifted lines. A corner with no decisive edge (mean step < 12 gray
levels) stays put. The `C` button is **progressive**: a repeat press within
2 s escalates the search box (±25 → L ±50 → XL ±100, shown as a badge on
the button); 2 s of inactivity, a rectangle Reset or an image switch drop
it back to normal. It is **multipass**: up to 4 passes, each re-centering the
search on the previous result, until every corner moves < 0.75 px — so a
corner can work its way to an edge slightly beyond one pass's ±25 px reach
(a real page's tilted detect edge needed this), while featureless
surroundings still stop the walk on the first pass and the pass cap bounds
total travel. It operates on ONE rectangle (the active one). Trigger
policy (keep it):

- Every detection — first visit of an image and the toolbar's Reset (drop
  all rectangles, detect afresh) alike — runs the intricate flow on every
  detected rectangle: auto-detect → snap corners → shrink 5 px inward (so
  the default crop carries no background sliver).
- Snap also runs on a rectangle completed by the fourth manual corner click,
  and via the `C` shortcut / "Correct boundaries" button — but **never after
  a manual corner drag** (the loupe exists for deliberate placement; snapping
  would fight it).

## Warping

`warpPerspective` in `homography.ts` does the full-resolution bicubic warp in
chunks and reports progress (0..1) so the UI can show a progress bar; keep it
pure and chunked (it runs on the main thread).
