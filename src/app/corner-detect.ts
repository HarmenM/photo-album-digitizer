import { Point, insetQuad, sortCorners } from './homography';

interface HoughLine {
  rho: number; // signed distance from origin, in pixels
  theta: number; // normal angle in degrees, [0, 180)
  votes: number;
}

/**
 * Detect the four corners of a photographed page.
 *
 * Classic document-scanner pipeline, implemented without dependencies:
 * downscale -> grayscale -> gaussian blur -> Sobel gradients -> thinned edge
 * map -> Hough transform -> pick the two strongest pairs of roughly parallel
 * lines -> intersect them. Returns corners in full-resolution image
 * coordinates (sorted TL, TR, BR, BL), or null when no plausible page
 * outline is found.
 */
export function detectPageCorners(img: ImageBitmap): Point[] | null {
  const MAX_DIM = 700;
  const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
  const w = Math.max(8, Math.round(img.width * scale));
  const h = Math.max(8, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const quad = houghQuad(ctx.getImageData(0, 0, w, h).data, w, h);
  if (!quad) return null;
  const sx = img.width / w;
  const sy = img.height / h;
  return quad.map((p) => ({
    x: Math.min(Math.max(p.x * sx, 0), img.width),
    y: Math.min(Math.max(p.y * sy, 0), img.height),
  }));
}

/**
 * The Hough line-pair quad fit at the heart of detectPageCorners, in local
 * pixel coordinates. Without `guide` the widest plausible quad wins (the
 * page outline). With `guide` the valid quad that best overlaps it wins —
 * used to refine a coarse photo quad without latching onto a neighbor's edge.
 */
function houghQuad(rgba: Uint8ClampedArray, w: number, h: number, guide?: Point[]): Point[] | null {
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  const blur = gaussianBlur5(gray, w, h);

  // Sobel gradients
  const mag = new Float32Array(w * h);
  const dirDeg = new Float32Array(w * h); // gradient (= line normal) angle, [0, 180)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        blur[i - w + 1] +
        2 * blur[i + 1] +
        blur[i + w + 1] -
        blur[i - w - 1] -
        2 * blur[i - 1] -
        blur[i + w - 1];
      const gy =
        blur[i + w - 1] +
        2 * blur[i + w] +
        blur[i + w + 1] -
        blur[i - w - 1] -
        2 * blur[i - w] -
        blur[i - w + 1];
      mag[i] = Math.hypot(gx, gy);
      let ang = (Math.atan2(gy, gx) * 180) / Math.PI;
      if (ang < 0) ang += 180;
      dirDeg[i] = ang >= 180 ? 0 : ang;
    }
  }

  // Adaptive threshold, capped so a few very-high-contrast details cannot
  // push it above the (possibly softer) page edges
  const nonZero: number[] = [];
  for (let i = 0; i < mag.length; i++) if (mag[i] > 1) nonZero.push(mag[i]);
  if (nonZero.length < 100) return null;
  nonZero.sort((a, b) => a - b);
  const thr = Math.max(15, Math.min(nonZero[Math.floor(nonZero.length * 0.88)], 80));

  // Thin edges: keep only local maxima along the gradient direction
  const NMS_OFFSETS = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
  ];
  const edgeX: number[] = [];
  const edgeY: number[] = [];
  const edgeTheta: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m < thr) continue;
      const sector = Math.round(dirDeg[i] / 45) % 4;
      const [dx, dy] = NMS_OFFSETS[sector];
      if (m < mag[i + dy * w + dx] || m < mag[i - dy * w - dx]) continue;
      edgeX.push(x);
      edgeY.push(y);
      edgeTheta.push(Math.round(dirDeg[i]) % 180);
    }
  }
  if (edgeX.length < 100) return null;

  // Hough transform; each edge pixel votes only near its own normal angle
  const N_THETA = 180;
  const diag = Math.ceil(Math.hypot(w, h));
  const nRho = 2 * diag + 1;
  const cosT = new Float64Array(N_THETA);
  const sinT = new Float64Array(N_THETA);
  for (let t = 0; t < N_THETA; t++) {
    cosT[t] = Math.cos((t * Math.PI) / 180);
    sinT[t] = Math.sin((t * Math.PI) / 180);
  }
  const acc = new Int32Array(N_THETA * nRho);
  const THETA_WINDOW = 20;
  for (let e = 0; e < edgeX.length; e++) {
    const x = edgeX[e];
    const y = edgeY[e];
    const t0 = edgeTheta[e];
    for (let dt = -THETA_WINDOW; dt <= THETA_WINDOW; dt++) {
      const t = (t0 + dt + N_THETA) % N_THETA;
      const r = Math.round(x * cosT[t] + y * sinT[t]) + diag;
      // smear across neighboring rho bins so rounding along a sloped line
      // still accumulates into a single sharp peak
      const base = t * nRho + r;
      acc[base]++;
      if (r > 0) acc[base - 1]++;
      if (r < nRho - 1) acc[base + 1]++;
    }
  }

  // Extract peaks with non-max suppression in (theta, rho) space
  const minVotes = Math.max(25, 0.12 * Math.min(w, h));
  const peaks: HoughLine[] = [];
  for (let n = 0; n < 40; n++) {
    let bestIdx = -1;
    let bestVotes = minVotes;
    for (let i = 0; i < acc.length; i++) {
      if (acc[i] > bestVotes) {
        bestVotes = acc[i];
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    const t = Math.floor(bestIdx / nRho);
    const r = bestIdx % nRho;
    peaks.push({ rho: r - diag, theta: t, votes: bestVotes });
    for (let dt = -10; dt <= 10; dt++) {
      const tt = t + dt;
      if (tt < 0 || tt >= N_THETA) continue;
      for (let dr = -12; dr <= 12; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= nRho) continue;
        acc[tt * nRho + rr] = 0;
      }
    }
  }
  if (peaks.length < 4) return null;

  // Split lines into two orientation groups (the two pairs of page edges)
  const ref = peaks[0].theta;
  const groupA: HoughLine[] = [];
  const groupB: HoughLine[] = [];
  for (const p of peaks) {
    (angleDiff(p.theta, ref) < 45 ? groupA : groupB).push(p);
  }
  if (groupB.length < 2 || groupA.length < 2) return null;

  const alignedA = groupA.map((p) => alignTo(p, ref));
  const alignedB = groupB.map((p) => alignTo(p, groupB[0].theta));

  // The page outline is the outermost pair of lines in each orientation
  // (interior content like text lines always lies between the page edges),
  // so try pair combinations from widest separation down until a plausible
  // quad appears.
  const minDim = Math.min(w, h);
  const pairsA = candidatePairs(alignedA, 0.12 * minDim);
  const pairsB = candidatePairs(alignedB, 0.12 * minDim);
  const combos: { pa: [HoughLine, HoughLine]; pb: [HoughLine, HoughLine]; sep: number }[] = [];
  for (const a of pairsA) {
    for (const b of pairsB) combos.push({ pa: a.pair, pb: b.pair, sep: a.sep + b.sep });
  }
  combos.sort((x, y) => y.sep - x.sep);
  let best: Point[] | null = null;
  let bestScore = -1;
  const tol = guide ? 0.02 * Math.max(w, h) + 2 : 0;
  const gx = guide ? guide.map((p) => p.x) : [];
  const gy = guide ? guide.map((p) => p.y) : [];
  for (const { pa, pb } of combos) {
    const corners = intersectPairs(pa, pb);
    if (!corners || !validQuad(corners, w, h)) continue;
    const sorted = sortCorners(corners);
    if (!guide) return sorted; // widest valid quad = the page outline
    // the guide (segmentation) overshoots outward, so the true edges lie
    // inside it — a candidate poking noticeably outside has latched onto
    // something behind the photo (e.g. the page edge) and must not win
    const cx = sorted.map((p) => p.x);
    const cy = sorted.map((p) => p.y);
    if (
      Math.min(...cx) < Math.min(...gx) - tol ||
      Math.max(...cx) > Math.max(...gx) + tol ||
      Math.min(...cy) < Math.min(...gy) - tol ||
      Math.max(...cy) > Math.max(...gy) + tol
    ) {
      continue;
    }
    const score = quadIoU(sorted, sortCorners(guide));
    if (score > bestScore) {
      bestScore = score;
      best = sorted;
    }
  }
  return best;
}

/** Intersection-over-union of two quads (both wound TL, TR, BR, BL). */
function quadIoU(a: Point[], b: Point[]): number {
  const inter = polyArea(clipPoly(a, b));
  const union = polyArea(a) + polyArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

const MIN_PHOTO_FRACTION = 0.1; // a photo must cover at least 10% of the image
const MAX_OVERLAP = 0.5; // drop a quad when more of it lies inside an accepted one
// Photoshop-style threshold level: pixels darker than the level count as
// "photo", brighter as page background. 0.6 was validated on real album
// pages with an actual Photoshop threshold layer; higher levels keep light
// photo content (sky, white borders) from being trimmed off the crop.
//
// Automatic level selection, take 3 (takes 1 and 2 — best score, and highest
// count over all levels — mis-picked on real pages): CLIMB from 0.6 in 0.05
// steps and keep the lowest step that explains the page — a higher step only
// becomes the new best when it PROGRESSES vs the best step so far (more
// rectangles resolved, or a matched rectangle growing ≥ 20% in area: real
// photo content was being trimmed) without DEGRADING it (fewer rectangles —
// photos merged; a previous rectangle no longer inside a new one — the blob
// drifted or fragmented; or corner angles further from 90° — shear creeping
// in). Both rules earned their keep on real pages:
// - degraded steps are skipped, not stops: a blob absorbing bright photo
//   content can pass through a transient non-rectangular shape (a real
//   mostly-bright photo segmented wrong at 0.6, empty at 0.65 and right from
//   0.7 up — its rectangle then grew 53%), so a higher level that again
//   beats the best step resumes the climb;
// - without the growth requirement the climb drifted to 0.9 on an already
//   solid photo, where near-page-white shading crept into the blob (+6% per
//   matched rectangle) and pushed the crop past the photo's edges;
// - a step whose quad swallows (nearly) the whole region is the threshold
//   FLOODING — no page background left to segment against — and is always
//   degradation, however containing and rectangular the quad is (on a real
//   page the flood step, 74% → 99%, sailed past the growth check as fake
//   progress). A photo genuinely filling most of the frame stays under the
//   fraction: its page margins, however slim, are real (a real one reached
//   90%).
const CLIMB_START = 0.6;
const CLIMB_STEP = 0.05;
const CLIMB_MAX = 0.9; // above this everything floods together
const CLIMB_CONTAIN_FRACTION = 0.9; // "inside": ≥ 90% of the old quad's area covered
const CLIMB_ANGLE_SLACK_DEG = 1; // ignore sub-degree angle jitter between steps
const CLIMB_GROWTH_MIN = 1.2; // growth below this is shading/morphology creep, not content
const CLIMB_FLOOD_FRACTION = 0.97; // a quad this big IS the region: the threshold flooded
const DILATE_PASSES = 2; // closes cracks and small holes before hole-filling
const ERODE_PASSES = 5; // net shrink after dilation separates touching photos
const NET_SHRINK = ERODE_PASSES - DILATE_PASSES; // per-side shrink to grow back
const MAX_SPLIT_ERODES = 4; // extra per-component erosions to break bridged blobs
const MAX_ASPECT = 3.5; // longest/shortest quad side; photos are never strips
const PAGE_FRACTION = 0.55; // a lone quad this big may be the album page, not a photo
// …but only when what surrounds it is mostly dark (the table the page lies
// on). A frame-filling photo is also a lone dominant quad, yet its surround
// is the bright page: on real pages the photo surrounds measured 1–23%
// dark (white page plus a dark table sliver at the frame edge), a table
// surround is nearly all dark.
const PAGE_SURROUND_DARK = 0.4;
// A photographed rectangle's corners stay close to 90°: the mild perspective
// of a handheld page shot bends them only a few degrees. 12° accepts that
// (plus diagonal-extremes fit slop) while rejecting sheared blobs — shadows,
// sleeves, half-merged neighbours — that are clearly not photos.
const MAX_CORNER_DEV_DEG = 12;

/**
 * Detect all photographs lying on a page (e.g. an album sheet photographed
 * from above). Returns one quad per photo, in full-resolution coordinates,
 * roughly in reading order; empty when nothing plausible is found.
 *
 * Pipeline per region: threshold on luminance (photos are darker than the
 * page, like a Photoshop threshold layer at `level` — or, without a level,
 * the automatic climb described at the CLIMB_* constants) -> close cracks
 * and fill
 * photo-internal holes -> erode (splits touching photos) -> connected
 * components -> fit a quad to each component via its diagonal extremes ->
 * keep only rectangul-ish quads covering >= 10% of the image whose corners
 * are 90°-ish (a photographed rectangle bends only a few degrees) -> greedily
 * drop quads that mostly overlap a bigger accepted one (this also covers
 * "no photographs inside photographs").
 *
 * The pipeline runs on the whole (downscaled) frame first. When that yields a
 * single dominant quad it is almost certainly the album page itself (page on
 * a table), so the pipeline runs a second time inside that quad, this time
 * with the page interior as background — that is what separates photos glued
 * onto a page from the page itself.
 *
 * Segmentation only DISCOVERS photos; its quads are coarse (blob extremes
 * plus morphology slop). Every found quad is then re-fitted precisely by
 * running the Hough line fit — the same one that makes single-page detection
 * accurate — on a full-resolution crop of just that photo.
 *
 * The diagonal-extremes fit assumes photos are roughly upright
 * (perspective-morphed is fine, heavily rotated is not) — rotate the page
 * first for those.
 */
export function detectPhotoRects(img: ImageBitmap, level?: number): Point[][] {
  const MAX_DIM = 600;
  const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
  const w = Math.max(8, Math.round(img.width * scale));
  const h = Math.max(8, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;

  const minQuadArea = MIN_PHOTO_FRACTION * w * h;
  const outer = detectInRegion(rgba, w, 0, 0, w, h, minQuadArea, level);
  let quads = outer.quads;

  // A single dominant quad is either the album page itself (page on a dark
  // table) or a photo filling most of the frame on a bright page. Decide by
  // what lies OUTSIDE the quad at the level that produced it: only a mostly
  // dark surround marks the page — then rerun the detection inside it, so
  // the page interior becomes the background. A photo's surround is the
  // bright page, and rerunning inside a photo would trade the correct crop
  // for whatever its content happens to segment into.
  const surround =
    quads.length === 1 && polyArea(quads[0]) >= PAGE_FRACTION * w * h
      ? darkFractionOutside(rgba, w, h, quads[0], outer.level)
      : null;
  if (surround !== null) {
    console.debug(`dominant quad — surround ${Math.round(surround * 100)}% dark`);
  }
  if (surround !== null && surround >= PAGE_SURROUND_DARK) {
    const xs = quads[0].map((p) => p.x);
    const ys = quads[0].map((p) => p.y);
    const inset = Math.max(3, Math.round(0.01 * Math.min(w, h)));
    const x0 = Math.max(0, Math.round(Math.min(...xs)) + inset);
    const y0 = Math.max(0, Math.round(Math.min(...ys)) + inset);
    const x1 = Math.min(w, Math.round(Math.max(...xs)) - inset);
    const y1 = Math.min(h, Math.round(Math.max(...ys)) - inset);
    if (x1 - x0 > 20 && y1 - y0 > 20) {
      const inner = detectInRegion(rgba, w, x0, y0, x1, y1, minQuadArea, level).quads;
      if (inner.length) quads = inner;
    }
  }

  console.debug(`detectPhotoRects @${level?.toFixed(2) ?? 'auto'}: ${quads.length} quad(s)`);

  // segmentation discovered the photos; the Hough line fit nails their edges
  const sx = img.width / w;
  const sy = img.height / h;
  return quads.map((quad) => {
    const full = quad.map((p) => ({ x: p.x * sx, y: p.y * sy }));
    return houghRefit(img, full) ?? full.map((p) => clampPt(p, img.width, img.height));
  });
}

function clampPt(p: Point, w: number, h: number): Point {
  return { x: Math.min(Math.max(p.x, 0), w), y: Math.min(Math.max(p.y, 0), h) };
}

/**
 * Fraction of the pixels outside the quad's bounding box that are darker
 * than the given threshold level. Returns 0 when almost nothing lies
 * outside — too small a sample to call the surround dark.
 */
function darkFractionOutside(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  quad: Point[],
  level: number,
): number {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const x0 = Math.max(0, Math.round(Math.min(...xs)));
  const y0 = Math.max(0, Math.round(Math.min(...ys)));
  const x1 = Math.min(w, Math.round(Math.max(...xs)));
  const y1 = Math.min(h, Math.round(Math.max(...ys)));
  const thr = level * 255;
  let dark = 0;
  let total = 0;
  for (let y = 0; y < h; y++) {
    const inRow = y >= y0 && y < y1;
    for (let x = 0; x < w; x++) {
      if (inRow && x >= x0 && x < x1) continue;
      const p = (y * w + x) * 4;
      const luma = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
      total++;
      if (luma < thr) dark++;
    }
  }
  return total >= 0.03 * w * h ? dark / total : 0;
}

/**
 * Re-fit one coarse photo quad precisely: crop the photo plus a small margin
 * from the full-resolution image and run the Hough quad fit on the crop,
 * keeping the candidate that best overlaps the coarse quad. Returns null
 * when no fit agrees with the coarse quad (IoU < 0.8) — then the coarse
 * quad itself is the best we have. A true refit only nudges edges by a few
 * percent; a lower IoU means the fit collapsed onto strong lines INSIDE the
 * photo because the real edge is too soft to peak (a pale path against the
 * white page cost a real photo a third of its width at the old 0.6 bar).
 */
function houghRefit(img: ImageBitmap, quad: Point[]): Point[] | null {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const mx = 0.08 * (Math.max(...xs) - Math.min(...xs)) + 8;
  const my = 0.08 * (Math.max(...ys) - Math.min(...ys)) + 8;
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - mx));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - my));
  const x1 = Math.min(img.width, Math.ceil(Math.max(...xs) + mx));
  const y1 = Math.min(img.height, Math.ceil(Math.max(...ys) + my));
  const cw0 = x1 - x0;
  const ch0 = y1 - y0;
  if (cw0 < 16 || ch0 < 16) return null;
  const scale = Math.min(1, 700 / Math.max(cw0, ch0));
  const cw = Math.max(8, Math.round(cw0 * scale));
  const ch = Math.max(8, Math.round(ch0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, x0, y0, cw0, ch0, 0, 0, cw, ch);
  const guide = quad.map((p) => ({ x: (p.x - x0) * scale, y: (p.y - y0) * scale }));
  const local = houghQuad(ctx.getImageData(0, 0, cw, ch).data, cw, ch, guide);
  if (!local) return null;
  const out = local.map((p) =>
    clampPt({ x: x0 + p.x / scale, y: y0 + p.y / scale }, img.width, img.height),
  );
  return quadIoU(sortCorners(out), sortCorners(quad)) >= 0.8 ? out : null;
}

/**
 * Masking + component pass over a region of the downscaled image. With an
 * explicit `level` it is a single pass at that threshold; without one it
 * CLIMBS: segment at 0.6, then repeatedly 0.05 higher, skipping degraded
 * steps, and keep the lowest step that no higher step genuinely improved on
 * (see climbDegradation, climbProgress and the CLIMB_* comment).
 * Returns accepted photo quads in downscaled image coordinates, reading
 * order, plus the threshold level that produced them.
 */
function detectInRegion(
  rgba: Uint8ClampedArray,
  imgW: number,
  rx0: number,
  ry0: number,
  rx1: number,
  ry1: number,
  minQuadArea: number,
  level?: number,
): { quads: Point[][]; level: number } {
  const w = rx1 - rx0;
  const h = ry1 - ry0;

  // crop the region into its own buffer; everything below is in local coords
  const crop = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y + ry0) * imgW + rx0) * 4;
    crop.set(rgba.subarray(src, src + w * 4), y * w * 4);
  }

  // luminance, blurred so photo edges stay closed — shared by climb steps
  const luma = new Float32Array(w * h);
  for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
    luma[i] = 0.299 * crop[p] + 0.587 * crop[p + 1] + 0.114 * crop[p + 2];
  }
  const blurred = gaussianBlur5(luma, w, h);
  const segment = (lv: number) => segmentAt(blurred, w, h, lv * 255, minQuadArea);

  let winner: Point[][];
  let winnerLevel: number;
  if (level !== undefined) {
    winner = segment(level);
    winnerLevel = level;
  } else {
    let best = segment(CLIMB_START);
    let bestLevel = CLIMB_START;
    const pct = (quads: Point[][]) =>
      Math.round(quads.reduce((a, q) => a + polyArea(q), 0) / (w * h) / 0.01);
    const steps = [`${CLIMB_START.toFixed(2)}: ${best.length}(${pct(best)}%)`];
    for (let lv = CLIMB_START + CLIMB_STEP; lv <= CLIMB_MAX + 1e-9; lv += CLIMB_STEP) {
      const next = segment(lv);
      const flooded = next.some((q) => polyArea(q) >= CLIMB_FLOOD_FRACTION * w * h);
      const worse = flooded ? 'flooded' : climbDegradation(best, next);
      const better = !worse && climbProgress(best, next);
      steps.push(
        `${lv.toFixed(2)}: ${next.length}(${pct(next)}%)${worse ? ` ✗ ${worse}` : better ? '' : ' ·'}`,
      );
      if (better) {
        best = next;
        bestLevel = lv;
      }
    }
    console.debug(
      `detectInRegion ${w}×${h} @(${rx0},${ry0}) — ${steps.join(' | ')} → level ${bestLevel.toFixed(2)}`,
    );
    winner = best;
    winnerLevel = bestLevel;
  }
  return {
    quads: winner.map((quad) => quad.map((p) => ({ x: p.x + rx0, y: p.y + ry0 }))),
    level: winnerLevel,
  };
}

/**
 * Is the climb step `next` a degradation of the best step `prev`? Returns
 * the reason (the step is skipped and `prev` kept), or null. The three
 * degradations: fewer rectangles (photos merged), a previous rectangle no
 * longer inside a new one (the blob drifted or fragmented), or a matched
 * rectangle's corners further from 90° than before (shear creeping in).
 */
function climbDegradation(prev: Point[][], next: Point[][]): string | null {
  if (next.length < prev.length) return 'fewer rectangles';
  for (const p of prev) {
    const inside = next.find(
      (n) => polyArea(clipPoly(p, n)) >= CLIMB_CONTAIN_FRACTION * polyArea(p),
    );
    if (!inside) return 'lost a rectangle';
    const prevDev = maxCornerAngleDev(p as [Point, Point, Point, Point]);
    const nextDev = maxCornerAngleDev(inside as [Point, Point, Point, Point]);
    if (nextDev > prevDev + CLIMB_ANGLE_SLACK_DEG) return 'angles degraded';
  }
  return null;
}

/**
 * Does the (non-degraded) climb step `next` actually improve on the best
 * step `prev`? Progress is more rectangles resolved, or a matched rectangle
 * growing by ≥ CLIMB_GROWTH_MIN (photo content that the lower threshold
 * trimmed off). Anything less — the same rectangles a few percent fatter —
 * is page shading and morphology creep, and keeping the lower level is what
 * stops the crop drifting past the photo's edges.
 */
function climbProgress(prev: Point[][], next: Point[][]): boolean {
  if (next.length > prev.length) return true;
  for (const p of prev) {
    const inside = next.find(
      (n) => polyArea(clipPoly(p, n)) >= CLIMB_CONTAIN_FRACTION * polyArea(p),
    );
    if (inside && polyArea(inside) >= CLIMB_GROWTH_MIN * polyArea(p)) return true;
  }
  return false;
}

/**
 * One masking + component pass at one threshold (0–255 scale). Returns
 * accepted photo quads in local region coordinates, reading order.
 */
function segmentAt(
  blurred: Float32Array,
  w: number,
  h: number,
  threshold: number,
  minQuadArea: number,
): Point[][] {
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = blurred[i] < threshold ? 1 : 0;
  // close cracks, then solidify photos whose bright content matches the page
  // color (holes), then shrink so touching photos come apart. Only holes
  // smaller than a photo are filled — the page enclosed by a table frame is
  // also "a hole" and flooding it would merge the whole frame into one blob.
  for (let e = 0; e < DILATE_PASSES; e++) mask = dilate(mask, w, h);
  fillHoles(mask, w, h, minQuadArea);
  for (let e = 0; e < ERODE_PASSES; e++) mask = erode(mask, w, h);

  const candidates: { quad: Point[]; area: number }[] = [];
  const minCcArea = 0.7 * minQuadArea; // pre-filter; exact area check on the quad
  const toPt = (i: number): Point => ({ x: i % w, y: Math.floor(i / w) });

  /**
   * Accept a component when it is rectangul-ish; otherwise erode it in
   * isolation and retry its pieces — this breaks photos that are bridged to
   * page edges or to each other by shadows.
   */
  const fitOrSplit = (comp: Component, extra: number): void => {
    const quad0: [Point, Point, Point, Point] = [
      toPt(comp.tl),
      toPt(comp.tr),
      toPt(comp.br),
      toPt(comp.bl),
    ];
    const fitArea = polyArea(quad0);
    const ratio = fitArea >= 1 ? comp.area / fitArea : 0;
    // angle check on quad0: expansion below offsets edges in parallel, so the
    // corner angles don't change. A sheared quad falls through to the split
    // retry — it is often two photos bridged by a diagonal shadow.
    if (ratio >= 0.72 && ratio <= 1.2 && maxCornerAngleDev(quad0) <= MAX_CORNER_DEV_DEG) {
      // grow back what the morphology and blur ate off the edges
      const expanded = insetQuad(quad0, -(NET_SHRINK + 1 + extra)) ?? quad0;
      const quadArea = polyArea(expanded);
      if (quadArea < minQuadArea) return;
      const sorted = sortCorners(expanded);
      if (quadAspect(sorted) > MAX_ASPECT) return; // strips (page edges) are not photos
      candidates.push({ quad: sorted, area: quadArea });
      return;
    }
    if (extra >= MAX_SPLIT_ERODES) return;
    // copy the component into its own padded mini-mask and erode once more
    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;
    for (const i of comp.pixels) {
      const x = i % w;
      const y = Math.floor(i / w);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const bw = maxX - minX + 3;
    const bh = maxY - minY + 3;
    const mini = new Uint8Array(bw * bh);
    for (const i of comp.pixels) {
      mini[(Math.floor(i / w) - minY + 1) * bw + ((i % w) - minX + 1)] = 1;
    }
    const eroded = erode(mini, bw, bh);
    const remap = (i: number) => (Math.floor(i / bw) + minY - 1) * w + ((i % bw) + minX - 1);
    for (const sub of componentsOf(eroded, bw, bh, minCcArea)) {
      fitOrSplit(
        {
          area: sub.area,
          pixels: sub.pixels.map(remap),
          tl: remap(sub.tl),
          tr: remap(sub.tr),
          br: remap(sub.br),
          bl: remap(sub.bl),
        },
        extra + 1,
      );
    }
  };
  for (const comp of componentsOf(mask, w, h, minCcArea)) fitOrSplit(comp, 0);

  // biggest first; drop quads that mostly lie inside an already accepted one
  candidates.sort((a, b) => b.area - a.area);
  const accepted: { quad: Point[]; area: number }[] = [];
  for (const c of candidates) {
    const overlapped = accepted.some(
      (a) => polyArea(clipPoly(c.quad, a.quad)) / c.area > MAX_OVERLAP,
    );
    if (!overlapped) accepted.push(c);
  }

  return readingOrder(
    accepted.map(({ quad }) => quad),
    h,
  );
}

/**
 * Sort quads into reading order — by row band (a quarter of the region
 * height), then left to right — the order the crop-number bubbles and the
 * "photo i / n" counter present them in. Also used to renumber after a
 * rotation, so the numbering always reads top-left first in the current
 * orientation.
 */
export function readingOrder(quads: Point[][], regionH: number): Point[][] {
  const center = (q: Point[]) => ({
    x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4,
    y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4,
  });
  const band = regionH * 0.25;
  return quads.slice().sort((a, b) => {
    const ca = center(a);
    const cb = center(b);
    const rowDiff = Math.floor(ca.y / band) - Math.floor(cb.y / band);
    return rowDiff || ca.x - cb.x;
  });
}

interface Component {
  area: number;
  pixels: number[]; // mask indices
  tl: number; // extreme pixel indices: min x+y, max x-y, max x+y, min x-y
  tr: number;
  br: number;
  bl: number;
}

/** Connected components (4-connectivity) with their diagonal extremes. */
function componentsOf(mask: Uint8Array, w: number, h: number, minArea: number): Component[] {
  const labels = new Int32Array(w * h);
  const out: Component[] = [];
  const stack: number[] = [];
  const sOf = (i: number) => (i % w) + Math.floor(i / w);
  const dOf = (i: number) => (i % w) - Math.floor(i / w);
  let label = 0;
  for (let seed = 0; seed < mask.length; seed++) {
    if (!mask[seed] || labels[seed]) continue;
    label++;
    const pixels: number[] = [];
    let tl = seed;
    let tr = seed;
    let br = seed;
    let bl = seed;
    stack.push(seed);
    labels[seed] = label;
    while (stack.length) {
      const i = stack.pop()!;
      pixels.push(i);
      if (sOf(i) < sOf(tl)) tl = i;
      if (sOf(i) > sOf(br)) br = i;
      if (dOf(i) > dOf(tr)) tr = i;
      if (dOf(i) < dOf(bl)) bl = i;
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j >= 0 && j < mask.length && mask[j] && !labels[j]) {
          labels[j] = label;
          stack.push(j);
        }
      }
    }
    if (pixels.length >= minArea) out.push({ area: pixels.length, pixels, tl, tr, br, bl });
  }
  return out;
}

/** Largest deviation of the quad's four interior angles from 90°, in degrees. */
function maxCornerAngleDev(quad: [Point, Point, Point, Point]): number {
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    const cur = quad[i];
    const prev = quad[(i + 3) % 4];
    const next = quad[(i + 1) % 4];
    const a =
      Math.atan2(prev.y - cur.y, prev.x - cur.x) - Math.atan2(next.y - cur.y, next.x - cur.x);
    let deg = Math.abs((a * 180) / Math.PI);
    if (deg > 180) deg = 360 - deg;
    worst = Math.max(worst, Math.abs(deg - 90));
  }
  return worst;
}

/** Longest quad side divided by the shortest opposing pair. */
function quadAspect(s: [Point, Point, Point, Point]): number {
  const d = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const wSide = Math.max(d(s[0], s[1]), d(s[3], s[2]));
  const hSide = Math.max(d(s[0], s[3]), d(s[1], s[2]));
  return Math.max(wSide, hSide) / Math.max(1, Math.min(wSide, hSide));
}

/**
 * Turn small enclosed background pockets into foreground: photo content that
 * happens to match the page color (sky, white borders) must not punch holes
 * into the photo's component. Background is whatever reaches the mask
 * border. Holes of `maxArea` or larger stay — an enclosed area that big is
 * scenery (e.g. the page inside a table frame), not photo content.
 */
function fillHoles(mask: Uint8Array, w: number, h: number, maxArea: number): void {
  const reach = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!mask[i] && !reach[i]) {
      reach[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  // flood each unreached pocket separately and fill only the small ones
  const hole: number[] = [];
  for (let seed = 0; seed < mask.length; seed++) {
    if (mask[seed] || reach[seed]) continue;
    hole.length = 0;
    reach[seed] = 1;
    stack.push(seed);
    while (stack.length) {
      const i = stack.pop()!;
      hole.push(i);
      const x = i % w;
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (i >= w) push(i - w);
      if (i < w * (h - 1)) push(i + w);
    }
    if (hole.length < maxArea) for (const i of hole) mask[i] = 1;
  }
}

/** 3x3 cross dilation, the counterpart of erode(). */
function dilate(mask: Uint8Array, w: number, h: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      out[i] =
        mask[i] ||
        (x > 0 && mask[i - 1]) ||
        (x < w - 1 && mask[i + 1]) ||
        (y > 0 && mask[i - w]) ||
        (y < h - 1 && mask[i + w])
          ? 1
          : 0;
    }
  }
  return out;
}

/** 3x3 cross erosion; clears the one-pixel image border as a side effect. */
function erode(mask: Uint8Array, w: number, h: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      out[i] = mask[i] & mask[i - 1] & mask[i + 1] & mask[i - w] & mask[i + w];
    }
  }
  return out;
}

/** Shoelace area of a simple polygon. */
function polyArea(poly: Point[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/**
 * Sutherland–Hodgman clip of one convex polygon by another. Both must wind
 * TL->TR->BR->BL (clockwise in y-down coordinates), as sortCorners produces.
 */
function clipPoly(subject: Point[], clip: Point[]): Point[] {
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const inside = (p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= 0;
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j];
      const prev = input[(j + input.length - 1) % input.length];
      const curIn = inside(cur);
      const prevIn = inside(prev);
      if (curIn !== prevIn) {
        // intersection of prev->cur with the clip edge a->b
        const d1 = (b.x - a.x) * (prev.y - a.y) - (b.y - a.y) * (prev.x - a.x);
        const d2 = (b.x - a.x) * (cur.y - a.y) - (b.y - a.y) * (cur.x - a.x);
        const t = d1 / (d1 - d2);
        out.push({ x: prev.x + t * (cur.x - prev.x), y: prev.y + t * (cur.y - prev.y) });
      }
      if (curIn) out.push(cur);
    }
  }
  return out;
}

export const SNAP_RADIUS = 25; // half of the default 50 px search box around each corner
const SNAP_SEG_MIN = 6; // sample the edge from here (skips the messy corner junction)…
const SNAP_SEG_MAX = 42; // …to here, in px along the edge away from the corner
const SNAP_MIN_CONTRAST = 12; // mean gray-level step required to accept a snap
const SNAP_PASSES = 4; // re-snap until the corners settle…
const SNAP_SETTLED_PX = 0.75; // …moving less than this between passes

/**
 * Snap a quad's corners onto the photo's actual boundary, in multiple passes:
 * each pass re-centers the search on the previous result, so a corner can
 * work its way to an edge slightly beyond a single pass's reach, and the
 * corner intersections settle after their edges moved. Every pass still
 * requires a decisive contrast edge, so featureless surroundings stop the
 * walk immediately; the pass cap bounds total travel to
 * SNAP_PASSES × radius. Returns the corners in the order they were
 * passed in; a corner with no decisive contrast edge nearby stays where it
 * is. `radius` widens the per-pass search box (the "Correct boundaries"
 * button escalates it on repeated presses).
 */
export function snapCornersToEdges(
  img: ImageBitmap,
  corners: Point[],
  radius = SNAP_RADIUS,
): Point[] {
  let cur = corners;
  for (let pass = 0; pass < SNAP_PASSES; pass++) {
    const next = snapCornersOnce(img, cur, radius);
    const moved = Math.max(...next.map((p, i) => Math.hypot(p.x - cur[i].x, p.y - cur[i].y)));
    cur = next;
    if (moved < SNAP_SETTLED_PX) break;
  }
  return cur;
}

/**
 * One snap pass. Only a ±radius box around each corner is searched. The
 * boundary is assumed to be a hard contrast change (photo against a light
 * background), so each of the corner's two adjacent quad edges is slid along
 * its own normal to the offset with the strongest mean contrast across the
 * line; the snapped corner is the intersection of the two shifted lines.
 * Runs at full image resolution.
 */
function snapCornersOnce(img: ImageBitmap, corners: Point[], radius: number): Point[] {
  if (corners.length !== 4) return corners.slice();
  const sorted = sortCorners(corners);
  const snapped = new Map<Point, Point>();
  for (let i = 0; i < 4; i++) {
    snapped.set(
      sorted[i],
      snapCorner(img, sorted[i], sorted[(i + 3) % 4], sorted[(i + 1) % 4], radius),
    );
  }
  return corners.map((p) => snapped.get(p) ?? p);
}

function snapCorner(img: ImageBitmap, p: Point, prev: Point, next: Point, radius: number): Point {
  // patch big enough for the search box plus the sampled edge stretch
  const H = radius + SNAP_SEG_MAX + 3;
  const S = 2 * H + 1;
  const sx = Math.round(p.x) - H;
  const sy = Math.round(p.y) - H;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, sx, sy, S, S, 0, 0, S, S);
  const rgba = ctx.getImageData(0, 0, S, S).data;
  const grayRaw = new Float32Array(S * S);
  for (let i = 0, q = 0; i < grayRaw.length; i++, q += 4) {
    grayRaw[i] = 0.299 * rgba[q] + 0.587 * rgba[q + 1] + 0.114 * rgba[q + 2];
  }
  const gray = gaussianBlur5(grayRaw, S, S);

  // bilinear sample in patch coordinates; null outside the patch or the image
  const sample = (x: number, y: number): number | null => {
    const gx = x + sx;
    const gy = y + sy;
    if (gx < 1 || gy < 1 || gx > img.width - 2 || gy > img.height - 2) return null;
    if (x < 0 || y < 0 || x > S - 2 || y > S - 2) return null;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const i = y0 * S + x0;
    return (
      gray[i] * (1 - fx) * (1 - fy) +
      gray[i + 1] * fx * (1 - fy) +
      gray[i + S] * (1 - fx) * fy +
      gray[i + S + 1] * fx * fy
    );
  };

  const cx = p.x - sx;
  const cy = p.y - sy;

  // Slide the line through the corner with direction u along its normal n and
  // return the offset with the strongest mean contrast step across the line.
  const edgeOffset = (u: Point, n: Point): number => {
    let bestD = 0;
    let bestScore = -Infinity;
    for (let d = -radius; d <= radius; d++) {
      let sum = 0;
      let cnt = 0;
      for (let s = SNAP_SEG_MIN; s <= SNAP_SEG_MAX; s += 2) {
        const qx = cx + d * n.x + s * u.x;
        const qy = cy + d * n.y + s * u.y;
        const a = sample(qx + n.x, qy + n.y);
        const b = sample(qx - n.x, qy - n.y);
        if (a === null || b === null) continue;
        sum += Math.abs(a - b);
        cnt++;
      }
      if (cnt < 8) continue;
      // slight distance penalty so a weak far peak cannot beat staying put
      const score = sum / cnt - 0.15 * Math.abs(d);
      if (score > bestScore) {
        bestScore = score;
        bestD = d;
      }
    }
    return bestScore >= SNAP_MIN_CONTRAST ? bestD : 0;
  };

  const dirTo = (q: Point): Point | null => {
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    return len < 1 ? null : { x: (q.x - p.x) / len, y: (q.y - p.y) / len };
  };
  const uA = dirTo(prev);
  const uB = dirTo(next);
  if (!uA || !uB) return p;
  const nA = { x: -uA.y, y: uA.x };
  const nB = { x: -uB.y, y: uB.x };
  const dA = edgeOffset(uA, nA);
  const dB = edgeOffset(uB, nB);
  if (dA === 0 && dB === 0) return p;

  // intersect the two shifted edge lines
  const det = uA.x * uB.y - uA.y * uB.x;
  if (Math.abs(det) < 1e-6) return p;
  const ax = p.x + dA * nA.x;
  const ay = p.y + dA * nA.y;
  const bx = p.x + dB * nB.x;
  const by = p.y + dB * nB.y;
  const t = ((bx - ax) * uB.y - (by - ay) * uB.x) / det;
  const out = { x: ax + t * uA.x, y: ay + t * uA.y };
  // stay inside the search box (shallow edge angles can fling the
  // intersection far away)
  if (Math.abs(out.x - p.x) > radius || Math.abs(out.y - p.y) > radius) return p;
  return out;
}

/** Minimal angular distance between two line orientations, in [0, 90]. */
function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 180;
  return Math.min(d, 180 - d);
}

/** Re-express a line so its theta lies within ±90° of ref (flipping rho as needed). */
function alignTo(p: HoughLine, ref: number): HoughLine {
  let { rho, theta } = p;
  while (theta - ref > 90) {
    theta -= 180;
    rho = -rho;
  }
  while (theta - ref < -90) {
    theta += 180;
    rho = -rho;
  }
  return { rho, theta, votes: p.votes };
}

/** All sufficiently separated line pairs of a group, widest separation first. */
function candidatePairs(
  lines: HoughLine[],
  minSep: number,
): { pair: [HoughLine, HoughLine]; sep: number }[] {
  // drop weak "ridge ghost" peaks (voting-window leakage next to a strong
  // line) so the outermost-first search only considers real edges
  const maxVotes = Math.max(...lines.map((l) => l.votes));
  const strong = lines.filter((l) => l.votes >= 0.45 * maxVotes);
  const out: { pair: [HoughLine, HoughLine]; sep: number }[] = [];
  for (let i = 0; i < strong.length; i++) {
    for (let j = i + 1; j < strong.length; j++) {
      if (Math.abs(strong[i].theta - strong[j].theta) > 30) continue; // opposite page edges are near-parallel
      const sep = Math.abs(strong[i].rho - strong[j].rho);
      if (sep >= minSep) out.push({ pair: [strong[i], strong[j]], sep });
    }
  }
  out.sort((a, b) => b.sep - a.sep);
  return out.slice(0, 8);
}

function intersectPairs(
  pairA: [HoughLine, HoughLine],
  pairB: [HoughLine, HoughLine],
): Point[] | null {
  const pts: Point[] = [];
  for (const a of pairA) {
    for (const b of pairB) {
      const p = intersect(a, b);
      if (!p) return null;
      pts.push(p);
    }
  }
  return pts;
}

function intersect(a: HoughLine, b: HoughLine): Point | null {
  const ca = Math.cos((a.theta * Math.PI) / 180);
  const sa = Math.sin((a.theta * Math.PI) / 180);
  const cb = Math.cos((b.theta * Math.PI) / 180);
  const sb = Math.sin((b.theta * Math.PI) / 180);
  const det = ca * sb - sa * cb;
  if (Math.abs(det) < 1e-6) return null;
  return {
    x: (a.rho * sb - b.rho * sa) / det,
    y: (ca * b.rho - cb * a.rho) / det,
  };
}

function validQuad(pts: Point[], w: number, h: number): boolean {
  // all corners on (or very near) the image
  for (const p of pts) {
    if (p.x < -0.05 * w || p.x > 1.05 * w || p.y < -0.05 * h || p.y > 1.05 * h) return false;
  }
  const s = sortCorners(pts);
  // corners must be distinct
  for (let i = 0; i < 4; i++) {
    const q = s[(i + 1) % 4];
    if (Math.hypot(s[i].x - q.x, s[i].y - q.y) < 8) return false;
  }
  // convex, with a plausible page area
  let area = 0;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const p0 = s[i];
    const p1 = s[(i + 1) % 4];
    const p2 = s[(i + 2) % 4];
    area += p0.x * p1.y - p1.x * p0.y;
    const cross = (p1.x - p0.x) * (p2.y - p1.y) - (p1.y - p0.y) * (p2.x - p1.x);
    if (cross !== 0) {
      const cs = Math.sign(cross);
      if (sign !== 0 && cs !== sign) return false;
      sign = cs;
    }
  }
  area = Math.abs(area) / 2;
  return area >= 0.15 * w * h;
}

function gaussianBlur5(src: Float32Array, w: number, h: number): Float32Array {
  const K = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = -2; k <= 2; k++) {
        const xx = Math.min(Math.max(x + k, 0), w - 1);
        v += K[k + 2] * src[row + xx];
      }
      tmp[row + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = -2; k <= 2; k++) {
        const yy = Math.min(Math.max(y + k, 0), h - 1);
        v += K[k + 2] * tmp[yy * w + x];
      }
      out[y * w + x] = v;
    }
  }
  return out;
}
