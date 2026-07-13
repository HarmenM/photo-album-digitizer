import { Point, sortCorners } from './homography';

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
  const rgba = ctx.getImageData(0, 0, w, h).data;

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
        blur[i - w + 1] + 2 * blur[i + 1] + blur[i + w + 1] -
        blur[i - w - 1] - 2 * blur[i - 1] - blur[i + w - 1];
      const gy =
        blur[i + w - 1] + 2 * blur[i + w] + blur[i + w + 1] -
        blur[i - w - 1] - 2 * blur[i - w] - blur[i - w + 1];
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
  for (const { pa, pb } of combos) {
    const corners = intersectPairs(pa, pb);
    if (corners && validQuad(corners, w, h)) {
      const sx = img.width / w;
      const sy = img.height / h;
      return sortCorners(corners).map((p) => ({
        x: Math.min(Math.max(p.x * sx, 0), img.width),
        y: Math.min(Math.max(p.y * sy, 0), img.height),
      }));
    }
  }
  return null;
}

const SNAP_RADIUS = 25; // half of the 50 px search box around each corner
const SNAP_SEG_MIN = 6; // sample the edge from here (skips the messy corner junction)…
const SNAP_SEG_MAX = 42; // …to here, in px along the edge away from the corner
const SNAP_MIN_CONTRAST = 12; // mean gray-level step required to accept a snap

/**
 * Snap a quad's corners onto the photo's actual boundary.
 *
 * Only a 50 px box around each corner is searched. The boundary is assumed to
 * be a hard contrast change (photo against a light background), so each of
 * the corner's two adjacent quad edges is slid along its own normal to the
 * offset with the strongest mean contrast across the line; the snapped corner
 * is the intersection of the two shifted lines. Runs at full image
 * resolution. Returns the corners in the order they were passed in; a corner
 * with no decisive contrast edge nearby stays where it is.
 */
export function snapCornersToEdges(img: ImageBitmap, corners: Point[]): Point[] {
  if (corners.length !== 4) return corners.slice();
  const sorted = sortCorners(corners);
  const snapped = new Map<Point, Point>();
  for (let i = 0; i < 4; i++) {
    snapped.set(sorted[i], snapCorner(img, sorted[i], sorted[(i + 3) % 4], sorted[(i + 1) % 4]));
  }
  return corners.map((p) => snapped.get(p) ?? p);
}

function snapCorner(img: ImageBitmap, p: Point, prev: Point, next: Point): Point {
  // patch big enough for the search box plus the sampled edge stretch
  const H = SNAP_RADIUS + SNAP_SEG_MAX + 3;
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
    for (let d = -SNAP_RADIUS; d <= SNAP_RADIUS; d++) {
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
  // stay inside the 50 px search box (shallow edge angles can fling the
  // intersection far away)
  if (Math.abs(out.x - p.x) > SNAP_RADIUS || Math.abs(out.y - p.y) > SNAP_RADIUS) return p;
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
