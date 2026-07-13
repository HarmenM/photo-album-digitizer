export interface Point {
  x: number;
  y: number;
}

/**
 * Order 4 arbitrary points as [top-left, top-right, bottom-right, bottom-left].
 */
export function sortCorners(pts: Point[]): [Point, Point, Point, Point] {
  const bySum = [...pts].sort((p, q) => p.x + p.y - (q.x + q.y));
  const tl = bySum[0];
  const br = bySum[3];
  const [a, b] = bySum.slice(1, 3);
  const [tr, bl] = a.x - a.y > b.x - b.y ? [a, b] : [b, a];
  return [tl, tr, br, bl];
}

/**
 * Move every edge of a quad inward by `d` pixels and return the new corners
 * (same TL, TR, BR, BL order). Returns null when the quad is degenerate or
 * too small to shrink that far.
 */
export function insetQuad(sorted: [Point, Point, Point, Point], d: number): Point[] | null {
  // TL->TR->BR->BL is clockwise in y-down screen coordinates, so the inward
  // normal of a directed edge (dx, dy) is (-dy, dx)
  const edges = [];
  for (let i = 0; i < 4; i++) {
    const p = sorted[i];
    const q = sorted[(i + 1) % 4];
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return null;
    edges.push({ px: p.x - (dy / len) * d, py: p.y + (dx / len) * d, dx, dy });
  }
  const out: Point[] = [];
  for (let i = 0; i < 4; i++) {
    const a = edges[(i + 3) % 4]; // edge ending in corner i
    const b = edges[i]; // edge starting in corner i
    const det = a.dx * b.dy - a.dy * b.dx;
    if (Math.abs(det) < 1e-9) return null;
    const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / det;
    out.push({ x: a.px + t * a.dx, y: a.py + t * a.dy });
  }
  // reject when shrinking flipped the quad inside out
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const p = out[i];
    const q = out[(i + 1) % 4];
    area += p.x * q.y - q.x * p.y;
  }
  return area > 0 ? out : null;
}

/**
 * Compute the 3x3 homography (row-major, h[8] = 1) that maps each `from[i]`
 * to `to[i]` for the 4 point pairs.
 */
export function computeHomography(from: Point[], to: Point[]): Float64Array {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: X, y: Y } = to[i];
    a.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    b.push(X);
    a.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    b.push(Y);
  }
  return new Float64Array([...solve8(a, b), 1]);
}

function solve8(a: number[][], b: number[]): number[] {
  const n = 8;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    }
    [m[col], m[piv]] = [m[piv], m[col]];
    if (Math.abs(m[col][col]) < 1e-12) {
      throw new Error('Degenerate corner configuration (corners must not be collinear)');
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

/**
 * Inverse-map perspective warp with bicubic (Catmull-Rom) resampling.
 * `h` maps destination coordinates -> source coordinates. Sampling is done
 * once, directly from the full-resolution source pixels, to preserve as much
 * quality as possible. Runs in chunks and yields to the UI between chunks.
 */
export async function warpPerspective(
  src: ImageData,
  h: Float64Array,
  outW: number,
  outH: number,
  onProgress?: (fraction: number) => void,
): Promise<ImageData> {
  const sw = src.width;
  const sh = src.height;
  const sData = src.data;
  const out = new ImageData(outW, outH);
  const dData = out.data;
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = h;

  const wx = new Float64Array(4);
  const wy = new Float64Array(4);
  const xs = new Int32Array(4);
  const ys = new Int32Array(4);

  const rowsPerChunk = Math.max(1, Math.round(250_000 / outW));
  for (let yStart = 0; yStart < outH; yStart += rowsPerChunk) {
    const yEnd = Math.min(outH, yStart + rowsPerChunk);
    for (let y = yStart; y < yEnd; y++) {
      const cy = y + 0.5;
      let di = y * outW * 4;
      for (let x = 0; x < outW; x++, di += 4) {
        const cx = x + 0.5;
        const den = m6 * cx + m7 * cy + m8;
        // -0.5 converts from continuous coordinates to pixel-center index space
        const sx = (m0 * cx + m1 * cy + m2) / den - 0.5;
        const sy = (m3 * cx + m4 * cy + m5) / den - 0.5;

        const ix = Math.floor(sx);
        const iy = Math.floor(sy);
        cubicWeights(sx - ix, wx);
        cubicWeights(sy - iy, wy);
        for (let k = 0; k < 4; k++) {
          xs[k] = clampi(ix - 1 + k, sw - 1);
          ys[k] = clampi(iy - 1 + k, sh - 1);
        }

        let r = 0, g = 0, b = 0, a = 0;
        for (let j = 0; j < 4; j++) {
          const rowOff = ys[j] * sw;
          const wj = wy[j];
          for (let i = 0; i < 4; i++) {
            const w = wj * wx[i];
            const si = (rowOff + xs[i]) * 4;
            r += w * sData[si];
            g += w * sData[si + 1];
            b += w * sData[si + 2];
            a += w * sData[si + 3];
          }
        }
        // Catmull-Rom can overshoot; clamp to valid range
        dData[di] = r < 0 ? 0 : r > 255 ? 255 : r;
        dData[di + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
        dData[di + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
        dData[di + 3] = a < 0 ? 0 : a > 255 ? 255 : a;
      }
    }
    onProgress?.(yEnd / outH);
    await new Promise<void>((res) => setTimeout(res));
  }
  return out;
}

function cubicWeights(f: number, w: Float64Array): void {
  const f2 = f * f;
  const f3 = f2 * f;
  w[0] = 0.5 * (-f3 + 2 * f2 - f);
  w[1] = 0.5 * (3 * f3 - 5 * f2 + 2);
  w[2] = 0.5 * (-3 * f3 + 4 * f2 + f);
  w[3] = 0.5 * (f3 - f2);
}

function clampi(v: number, max: number): number {
  return v < 0 ? 0 : v > max ? max : v;
}
