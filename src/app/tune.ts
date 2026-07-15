/**
 * Photoshop-style image tuning: input levels (master RGB + per channel) and
 * legacy brightness/contrast, composed into per-channel 256-entry LUTs.
 * Pure functions, no Angular/DOM beyond the structural ImageData type — the
 * result-screen tune panel in app.ts is the only caller.
 */

export type TuneChannel = 'rgb' | 'r' | 'g' | 'b';

export interface ChannelLevels {
  black: number; // input black point, 0..254
  gamma: number; // midtones, 0.1..10 — > 1 brightens, like Photoshop's mid slider
  white: number; // input white point, 1..255
}

export interface Tune {
  levels: Record<TuneChannel, ChannelLevels>;
  brightness: number; // -100..100, additive (Photoshop legacy behavior)
  contrast: number; // -100..100, scales around middle gray
}

export function neutralLevels(): ChannelLevels {
  return { black: 0, gamma: 1, white: 255 };
}

export function defaultTune(): Tune {
  return {
    levels: { rgb: neutralLevels(), r: neutralLevels(), g: neutralLevels(), b: neutralLevels() },
    brightness: 0,
    contrast: 0,
  };
}

export function isNeutralLevels(l: ChannelLevels): boolean {
  return l.black === 0 && l.gamma === 1 && l.white === 255;
}

export function isNeutralTune(t: Tune): boolean {
  return (
    t.brightness === 0 &&
    t.contrast === 0 &&
    isNeutralLevels(t.levels.rgb) &&
    isNeutralLevels(t.levels.r) &&
    isNeutralLevels(t.levels.g) &&
    isNeutralLevels(t.levels.b)
  );
}

/** The levels remap as a plain function; identity short-circuits to a no-op. */
function levelsMap(l: ChannelLevels): (v: number) => number {
  if (isNeutralLevels(l)) return (v) => v;
  const range = Math.max(1, l.white - l.black);
  const inv = 1 / l.gamma;
  return (v) => {
    const n = Math.min(Math.max((v - l.black) / range, 0), 1);
    return 255 * Math.pow(n, inv);
  };
}

/**
 * One LUT per channel composing channel levels → master (RGB) levels →
 * brightness/contrast. Contrast uses the common 259-formula with the ±100
 * slider stretched to the formula's ±255 domain; brightness adds directly,
 * both matching Photoshop's legacy Brightness/Contrast.
 */
export function buildTuneLuts(t: Tune): [Uint8Array, Uint8Array, Uint8Array] {
  const cs = (t.contrast * 255) / 100;
  const cf = (259 * (cs + 255)) / (255 * (259 - cs));
  const master = levelsMap(t.levels.rgb);
  const lut = (c: 'r' | 'g' | 'b'): Uint8Array => {
    const chan = levelsMap(t.levels[c]);
    const out = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
      const x = (master(chan(v)) - 128) * cf + 128 + t.brightness;
      out[v] = x < 0 ? 0 : x > 255 ? 255 : Math.round(x);
    }
    return out;
  };
  return [lut('r'), lut('g'), lut('b')];
}

/** Map src through the tune's LUTs into dst (same dimensions); alpha is copied. */
export function applyTune(src: ImageData, dst: ImageData, t: Tune): void {
  const [lr, lg, lb] = buildTuneLuts(t);
  const s = src.data;
  const d = dst.data;
  for (let i = 0; i < s.length; i += 4) {
    d[i] = lr[s[i]];
    d[i + 1] = lg[s[i + 1]];
    d[i + 2] = lb[s[i + 2]];
    d[i + 3] = s[i + 3];
  }
}

/**
 * 256-bin histogram of one channel; 'rgb' uses Rec. 601 luminance, the same
 * weighting the photo detection thresholds on. Computed on the untuned
 * source — input levels are read against the input histogram.
 */
export function tuneHistogram(src: ImageData, channel: TuneChannel): Uint32Array {
  const bins = new Uint32Array(256);
  const d = src.data;
  if (channel === 'rgb') {
    for (let i = 0; i < d.length; i += 4) {
      bins[(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0]++;
    }
  } else {
    const off = channel === 'r' ? 0 : channel === 'g' ? 1 : 2;
    for (let i = off; i < d.length; i += 4) bins[d[i]]++;
  }
  return bins;
}
