import {
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  signal,
  viewChild,
} from '@angular/core';
import {
  SNAP_RADIUS,
  detectPageCorners,
  detectPhotoRects,
  readingOrder,
  snapCornersToEdges,
} from './corner-detect';
import { embedExifJpeg, parseSpokenDate, readExifDate } from './exif';
import { Point, computeHomography, insetQuad, sortCorners, warpPerspective } from './homography';
import {
  ChannelLevels,
  Tune,
  TuneChannel,
  applyTune,
  defaultTune,
  isNeutralLevels,
  isNeutralTune,
  tuneHistogram,
} from './tune';
import { amsterdamOffset } from './xmp';
import { ZipEntry, buildZip } from './zip';

type Mode = 'idle' | 'edit' | 'processing' | 'result' | 'collection' | 'done';
type ImageStatus = 'pending' | 'saved';
type DownloadStyle = 'single' | 'zip';

/** A saved photo held for the batch ZIP (zip download style). */
interface CollectedPhoto extends ZipEntry {
  thumb: string; // small dataURL for the collection page
}

interface QueueItem {
  id: number;
  file: File;
  name: string;
  thumb: string; // small dataURL, '' while still generating
  status: ImageStatus;
  rotation: number; // clockwise quarter turns applied in the editor: 0/90/180/270
  quads?: Point[][]; // last photo rectangles; undefined = never visited (auto-detect)
}

/** A named tune saved for reuse (persisted in localStorage). */
interface TunePreset {
  id: number;
  name: string;
  tune: Tune;
}

/** The tune-panel readouts that double as click-to-type inputs. */
type TuneNumField = 'black' | 'gamma' | 'white' | 'brightness' | 'contrast';

interface ScratchEntry {
  id: number;
  kind: 'date' | 'description';
  text: string; // display text
  dateIso?: string; // YYYY-MM-DD, only for kind 'date'
  used?: number; // how often this date was applied; each use adds one second
}

interface EdgeDrag {
  rawA: number; // indices into the corners() array
  rawB: number;
  startA: Point;
  startB: Point;
  normal: Point; // unit vector perpendicular to the edge
  startPointer: Point;
  tMin: number;
  tMax: number;
}

// the Web Speech API recognition types are not in TypeScript's DOM lib yet
interface RecognitionResult extends ArrayLike<{ transcript: string }> {
  isFinal: boolean;
}
interface RecognitionEvent {
  results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean; // keep listening until stop() — dictaphone mode
  maxAlternatives: number;
  onresult: ((ev: RecognitionEvent) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

const HIT_RADIUS_CSS_PX = 16;
const SCRATCH_STORAGE_KEY = 'photo-album-digitizer.scratchpad';
const SETTINGS_STORAGE_KEY = 'photo-album-digitizer.settings';
const TUNE_PRESETS_STORAGE_KEY = 'photo-album-digitizer.tune-presets';
// pre-rename keys ("Photo Rectifier"), still read as a fallback so existing
// scratchpads and settings survive the rename
const OLD_SCRATCH_STORAGE_KEY = 'photo-rectifier.scratchpad';
const OLD_SETTINGS_STORAGE_KEY = 'photo-rectifier.settings';
const DEFAULT_TIME = '12:00:00';
const DEFAULT_JPEG_QUALITY = 0.95;
const DEFAULT_FILENAME_SUFFIX = '-result';
// progressive boundary correction: pressing C / the button again within 2 s
// widens the snap search box (normal ±25 → L ±50 → XL ±100)
const SNAP_RADII = [SNAP_RADIUS, SNAP_RADIUS * 2, SNAP_RADIUS * 4];
const SNAP_BADGES = ['', 'L', 'XL'];
const SNAP_ESCALATE_MS = 2000;
const SNAP_FLASH_MS = 1000; // how long the search-area circles stay visible

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly mode = signal<Mode>('idle');
  protected readonly dragOver = signal(false);
  // photo rectangles on the current image; one is active and editable
  protected readonly quads = signal<Point[][]>([]);
  protected readonly draft = signal<Point[]>([]); // manually clicked corners, < 4
  // "add photo" mode: entered via the toolbar button, canceled by pressing
  // it again or Esc; plain canvas clicks place corners only while this is on
  protected readonly drafting = signal(false);
  protected readonly activeIdx = signal(-1);
  protected readonly progress = signal(0);
  protected readonly outSize = signal<{ w: number; h: number } | null>(null);
  // rectified photos of the current image, shown one at a time
  private results: HTMLCanvasElement[] = [];
  protected readonly resultIndex = signal(0);
  // per rectified photo: saved, closed without saving, or still pending —
  // the result screen only advances to the next image when none are pending
  protected readonly resultStatus = signal<('pending' | 'saved' | 'closed')[]>([]);
  // --- image tune (result screen; per rectified photo, baked into the save) ---
  protected readonly tune = signal<Tune>(defaultTune());
  protected readonly tuneChannel = signal<TuneChannel>('rgb');
  protected readonly tuneChannelIds: TuneChannel[] = ['rgb', 'r', 'g', 'b'];
  protected readonly tuneLevels = computed(() => this.tune().levels[this.tuneChannel()]);
  protected readonly tuneNeutral = computed(() => isNeutralTune(this.tune()));
  // before/after comparison, Photoshop-preview style: eye on (default) shows
  // the tuned photo, eye off the untuned original (save() re-bakes first
  // when off — the canvas is what gets exported)
  protected readonly tunePreview = signal(true);
  // the last non-neutral tune configured on any photo, for "use previous"
  // (in-memory, like the metadata bar's lastMeta; cleared on batch reset)
  protected readonly lastTune = signal<Tune | null>(null);
  // named tunes for reuse across sessions (persisted in localStorage)
  protected readonly tunePresets = signal<TunePreset[]>([]);
  protected readonly presetModalOpen = signal(false);
  private presetId = 0;
  // which slider readout is currently being typed into (click-to-edit); the
  // matching <b> is swapped for a digit-only input while set
  protected readonly editingTuneField = signal<TuneNumField | null>(null);
  // Escape cancels an in-progress edit; the flag tells the (blur) commit that
  // fired from the Escape-triggered blur to discard instead of applying
  private tuneEditCanceled = false;
  // the value applies live as you type, debounced; this holds the pending
  // timer and the tune snapshot taken when editing began, so a cancel can
  // undo whatever the live edits already changed
  private tuneEditTimer = 0;
  private tuneEditSnapshot: Tune | null = null;
  // the gamma slider is log-scaled: ±100 ↦ gamma 0.1..10, 0 = neutral
  protected readonly gammaSliderValue = computed(() =>
    Math.round(Math.log10(this.tuneLevels().gamma) * 100),
  );
  private tunes: Tune[] = []; // parallel to results
  // untuned pixels + per-channel histograms of the shown photo, cached so
  // slider drags only pay the LUT pass (invalidated on photo switch/rotate)
  private tuneSrc: ImageData | null = null;
  private tuneDst: ImageData | null = null;
  private histograms = new Map<TuneChannel, Uint32Array>();
  private tuneRaf = 0;

  // metadata of the last save with actual input, for the "use previous" button
  protected readonly lastMeta = signal<{ date: string; time: string; description: string } | null>(
    null,
  );
  // photos collected for the batch ZIP (zip download style) — the ZIP
  // entries carry the photo's date as file date, which a plain download
  // cannot; re-processing a photo appends under a higher number suffix
  protected readonly zipEntries = signal<CollectedPhoto[]>([]);

  // --- settings (persisted in localStorage) ---
  protected readonly settingsOpen = signal(false);
  protected readonly jpegQuality = signal(DEFAULT_JPEG_QUALITY);
  protected readonly downloadStyle = signal<DownloadStyle>('single');
  // appended to the source name in saved file names (may be empty)
  protected readonly filenameSuffix = signal(DEFAULT_FILENAME_SUFFIX);

  // progressive boundary correction (see SNAP_RADII): the escalation level
  // of the last snap; > 0 shows as the L/XL badge on the button
  protected readonly snapLevel = signal(0);
  protected readonly snapBadge = computed(() => SNAP_BADGES[this.snapLevel()]);
  private snapLevelTimer: ReturnType<typeof setTimeout> | null = null;
  // search-area visualisation: circles around the pre-snap corners, shown
  // for SNAP_FLASH_MS after each snap (this field, its timer and the block
  // in redraw() are the whole feature — delete those to revert it)
  private snapFlash: { centers: Point[]; radius: number } | null = null;
  private snapFlashTimer: ReturnType<typeof setTimeout> | null = null;
  private returnMode: Mode = 'edit'; // where the collection page goes back to
  protected readonly resultCount = signal(0);
  // small dataURLs for the bottom strip on the result screen (2+ photos only)
  protected readonly resultThumbs = signal<string[]>([]);

  // image queue
  protected readonly images = signal<QueueItem[]>([]);
  protected readonly currentIndex = signal(-1);
  protected readonly savedCount = computed(
    () => this.images().filter((i) => i.status === 'saved').length,
  );

  // metadata for the current result
  protected readonly photoDate = signal<Date | null>(null);
  protected readonly dateField = signal('');
  protected readonly timeField = signal(DEFAULT_TIME);
  protected readonly descriptionField = signal('');

  /** EXIF capture moment; used silently as the fallback when no date is entered. */
  private readonly exifDate = computed(() => {
    const d = this.photoDate();
    if (!d) return null;
    const pad = (n: number) => String(n).padStart(2, '0');
    return {
      iso: toIsoDate(d),
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    };
  });

  // shared scratchpad, filled from "use info" pages
  protected readonly scratchpad = signal<ScratchEntry[]>([]);
  protected readonly scratchDates = computed(() =>
    this.scratchpad().filter((e) => e.kind === 'date'),
  );
  protected readonly scratchDescriptions = computed(() =>
    this.scratchpad().filter((e) => e.kind === 'description'),
  );
  // collapsed = slim rail only; the panel stays on screen so expanding is one click
  protected readonly scratchCollapsed = signal(false);

  protected readonly listening = signal(false);
  // consent modal shown before the first dictation when the mic permission
  // has not been granted yet (some browsers stream audio to a cloud STT)
  protected readonly micConsentOpen = signal(false);
  // set once the user presses Continue; the modal then never nags again this
  // session and a later mic press starts recording directly
  private micConsentAcknowledged = false;
  private pendingDictateTarget: 'field' | 'scratchpad' | null = null;
  // active dictation (dictaphone: press to start, press again to stop)
  private rec: Recognition | null = null;
  private dictationTarget: 'field' | 'scratchpad' = 'field';
  private dictationText = ''; // accumulated final transcript
  private dictationInterim = ''; // last not-yet-final tail (applied too, so stopping never drops it)
  private dictationErrored = false;
  protected readonly voiceStatus = signal<string | null>(null);
  protected readonly zoom = signal(1);
  protected readonly loupeVisible = signal(false);

  protected readonly hint = computed(() => {
    if (this.drafting()) {
      return `Click the corners of a photo — ${4 - this.draft().length} to go (Esc cancels)`;
    }
    const n = this.quads().length;
    if (n === 0) return 'No photos marked — press Reset to re-detect, or mark one manually';
    return `${n} photo${n > 1 ? 's' : ''} selected`;
  });

  private readonly editCanvas = viewChild.required<ElementRef<HTMLCanvasElement>>('editCanvas');
  private readonly canvasHost = viewChild.required<ElementRef<HTMLDivElement>>('canvasHost');
  private readonly resultCanvas = viewChild.required<ElementRef<HTMLCanvasElement>>('resultCanvas');
  private readonly resultHost = viewChild.required<ElementRef<HTMLDivElement>>('resultHost');
  private readonly loupeCanvas = viewChild.required<ElementRef<HTMLCanvasElement>>('loupeCanvas');
  // not .required: the tune panel exists only on the result screen (and not
  // while the side panel is collapsed)
  private readonly histCanvas = viewChild<ElementRef<HTMLCanvasElement>>('histCanvas');
  private readonly presetNameInput = viewChild<ElementRef<HTMLInputElement>>('presetNameInput');
  // the inline click-to-edit number input; only one renders at a time (@if on
  // editingTuneField), so a single shared ref always points at the live one
  private readonly tuneNumInput = viewChild<ElementRef<HTMLInputElement>>('tuneNumInput');

  private image: ImageBitmap | null = null;
  private baseName = 'photo';
  private prevMode: Mode = 'idle'; // previous mode, for the result-screen history entry
  private viewScale = 1;
  private renderScale = 1; // image px -> canvas backing-store px
  private dragIndex = -1;
  private dragKind: 'quad' | 'draft' = 'quad';
  private edgeDrag: EdgeDrag | null = null;
  private editPan: {
    clientX: number;
    clientY: number;
    scrollLeft: number;
    scrollTop: number;
    moved: boolean;
    imgPoint: Point;
  } | null = null;
  private hostPan: { x: number; y: number; left: number; top: number; el: HTMLElement } | null =
    null;
  private rotating = false;
  private itemId = 0;
  private scratchId = 0;
  private openToken = 0;

  constructor() {
    // the scratchpad survives reloads via localStorage
    try {
      const raw =
        localStorage.getItem(SCRATCH_STORAGE_KEY) ?? localStorage.getItem(OLD_SCRATCH_STORAGE_KEY);
      if (raw) {
        const entries = (JSON.parse(raw) as ScratchEntry[]).filter(
          (e) =>
            e &&
            typeof e.id === 'number' &&
            (e.kind === 'date' || e.kind === 'description') &&
            typeof e.text === 'string',
        );
        this.scratchpad.set(entries);
        this.scratchId = entries.reduce((m, e) => Math.max(m, e.id), 0);
      }
    } catch {
      // corrupted storage — start with an empty scratchpad
    }
    effect(() => {
      localStorage.setItem(SCRATCH_STORAGE_KEY, JSON.stringify(this.scratchpad()));
    });
    // settings survive reloads too
    try {
      const raw =
        localStorage.getItem(SETTINGS_STORAGE_KEY) ??
        localStorage.getItem(OLD_SETTINGS_STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw) as {
          jpegQuality?: unknown;
          downloadStyle?: unknown;
          filenameSuffix?: unknown;
        };
        if (typeof s.jpegQuality === 'number' && s.jpegQuality >= 0.5 && s.jpegQuality <= 1) {
          this.jpegQuality.set(s.jpegQuality);
        }
        if (s.downloadStyle === 'single' || s.downloadStyle === 'zip') {
          this.downloadStyle.set(s.downloadStyle);
        }
        if (typeof s.filenameSuffix === 'string' && s.filenameSuffix.length <= 40) {
          this.filenameSuffix.set(sanitizeSuffix(s.filenameSuffix));
        }
      }
    } catch {
      // corrupted storage — keep the defaults
    }
    effect(() => {
      localStorage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify({
          jpegQuality: this.jpegQuality(),
          downloadStyle: this.downloadStyle(),
          filenameSuffix: this.filenameSuffix(),
        }),
      );
    });
    // tune presets survive reloads too
    try {
      const raw = localStorage.getItem(TUNE_PRESETS_STORAGE_KEY);
      if (raw) {
        const presets = (JSON.parse(raw) as TunePreset[]).filter(isValidTunePreset);
        this.tunePresets.set(presets);
        this.presetId = presets.reduce((m, p) => Math.max(m, p.id), 0);
      }
    } catch {
      // corrupted storage — start without presets
    }
    effect(() => {
      localStorage.setItem(TUNE_PRESETS_STORAGE_KEY, JSON.stringify(this.tunePresets()));
    });
    // The browser Back button leaves the result screen like Esc does:
    // entering the result pushes a history entry (so Back has something to
    // pop instead of leaving the app), and any other exit — Esc, Save &
    // next, opening another photo — consumes that entry again so history
    // does not accumulate. onPopState handles the Back press itself.
    effect(() => {
      const mode = this.mode();
      const was = this.prevMode;
      this.prevMode = mode;
      if (mode === 'result' && was !== 'result') {
        history.pushState({ resultScreen: true }, '');
      } else if (was === 'result' && mode !== 'result' && history.state?.resultScreen) {
        history.back();
      }
    });
  }

  // --- file loading & queue -------------------------------------------------

  @HostListener('window:dragover', ['$event'])
  protected onWindowDragOver(ev: DragEvent): void {
    ev.preventDefault();
    if (ev.dataTransfer) {
      ev.dataTransfer.dropEffect = 'copy';
      this.dragOver.set(true);
    }
  }

  @HostListener('window:dragleave', ['$event'])
  protected onWindowDragLeave(ev: DragEvent): void {
    if (!ev.relatedTarget) this.dragOver.set(false);
  }

  @HostListener('window:drop', ['$event'])
  protected onWindowDrop(ev: DragEvent): void {
    ev.preventDefault();
    this.dragOver.set(false);
    if (this.mode() === 'processing') return;
    const files = Array.from(ev.dataTransfer?.files ?? []).filter((f) =>
      f.type.startsWith('image/'),
    );
    if (files.length) void this.enqueueFiles(files);
  }

  protected onFileInput(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files ?? []).filter((f) => f.type.startsWith('image/'));
    input.value = '';
    if (files.length) void this.enqueueFiles(files);
  }

  private async enqueueFiles(files: File[]): Promise<void> {
    const firstNew = this.images().length;
    const newItems: QueueItem[] = files.map((file) => ({
      id: ++this.itemId,
      file,
      name: file.name,
      thumb: '',
      status: 'pending',
      rotation: 0,
    }));
    this.images.update((list) => [...list, ...newItems]);
    // newly added photos take the stage: open the first of them right away
    // (unless a warp is in flight — never yank the screen mid-processing).
    // Current quads are stashed by openImage, so nothing is lost.
    if (this.mode() !== 'processing') void this.openImage(firstNew);
    for (const item of newItems) {
      const thumb = await this.makeThumb(item.file).catch(() => '');
      this.images.update((list) => list.map((it) => (it.id === item.id ? { ...it, thumb } : it)));
    }
  }

  private async makeThumb(file: File): Promise<string> {
    const bmp = await createImageBitmap(file, {
      resizeWidth: 160,
      imageOrientation: 'from-image',
    });
    const thumb = this.thumbFromBitmap(bmp);
    bmp.close();
    return thumb;
  }

  private thumbFromBitmap(bmp: ImageBitmap): string {
    const scale = Math.min(1, 160 / bmp.width);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.75);
  }

  /** Rotate a bitmap by 0/90/180/270 degrees clockwise, closing the input. */
  private async rotateBitmapQuarter(bmp: ImageBitmap, rotation: number): Promise<ImageBitmap> {
    if (!rotation) return bmp;
    const swap = rotation === 90 || rotation === 270;
    const c = document.createElement('canvas');
    c.width = swap ? bmp.height : bmp.width;
    c.height = swap ? bmp.width : bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
    const rotated = await createImageBitmap(c);
    bmp.close();
    return rotated;
  }

  /** Remember the current image's rectangles so they survive switching away. */
  private stashQuads(): void {
    const idx = this.currentIndex();
    if (idx < 0 || !this.image) return;
    const qs = this.quads().map((q) => q.map((p) => ({ ...p })));
    this.images.update((list) => list.map((it, i) => (i === idx ? { ...it, quads: qs } : it)));
  }

  protected async openImage(index: number): Promise<void> {
    const item = this.images()[index];
    if (!item || this.mode() === 'processing') return;
    this.stashQuads();
    const token = ++this.openToken;
    this.currentIndex.set(index);
    // empty state (and thumb count) for the new item while it decodes
    this.quads.set([]);
    this.draft.set([]);
    this.drafting.set(false);
    this.activeIdx.set(-1);
    this.resetSnapLevel();
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(item.file, { imageOrientation: 'from-image' });
    } catch {
      alert(`Could not read “${item.name}” as an image.`);
      return;
    }
    if (token !== this.openToken) {
      bmp.close(); // a newer openImage won the race
      return;
    }
    if (item.rotation) {
      bmp = await this.rotateBitmapQuarter(bmp, item.rotation);
      if (token !== this.openToken) {
        bmp.close();
        return;
      }
    }
    this.image?.close();
    this.image = bmp;
    this.baseName = item.name.replace(/\.[^.]+$/, '') || 'photo';
    const stored = item.quads;
    this.quads.set(stored ? stored.map((q) => q.map((p) => ({ ...p }))) : []);
    this.activeIdx.set(stored?.length ? 0 : -1);
    this.results = [];
    this.resultCount.set(0);
    this.resultThumbs.set([]);
    this.resultStatus.set([]);
    this.outSize.set(null);
    this.photoDate.set(null);
    this.setVoiceStatus(null);
    void item.file.arrayBuffer().then((buf) => {
      if (token === this.openToken) this.photoDate.set(readExifDate(buf));
    });
    this.resetZoom();
    this.mode.set('edit');
    // wait one frame so the edit screen has been laid out before measuring
    requestAnimationFrame(() => {
      this.layoutEditCanvas();
      if (!stored) this.autoDetect(false); // first visit: try to prefill corners
    });
  }

  /** Remove one image from the batch. */
  protected removeImage(index: number, ev: Event): void {
    ev.stopPropagation();
    if (this.mode() === 'processing') return;
    const cur = this.currentIndex();
    const newList = this.images().filter((_, i) => i !== index);
    this.images.set(newList);
    if (!newList.length) {
      this.openToken++;
      this.image?.close();
      this.image = null;
      this.currentIndex.set(-1);
      this.mode.set('idle');
    } else if (index < cur) {
      this.currentIndex.set(cur - 1);
    } else if (index === cur) {
      void this.openImage(Math.min(index, newList.length - 1));
    }
  }

  /** Advance to the next unprocessed image, or the done screen. */
  private advance(): void {
    const list = this.images();
    const cur = this.currentIndex();
    const indices = list.map((_, i) => i);
    const order = indices.slice(cur + 1).concat(indices.slice(0, cur + 1));
    const next = order.find((i) => list[i].status === 'pending');
    if (next !== undefined) {
      void this.openImage(next);
    } else {
      this.image?.close();
      this.image = null;
      this.currentIndex.set(-1);
      this.mode.set('done');
    }
  }

  private markCurrent(status: ImageStatus): void {
    const idx = this.currentIndex();
    this.images.update((list) => list.map((it, i) => (i === idx ? { ...it, status } : it)));
  }

  /**
   * Detect all photographs on the image automatically (falling back to the
   * single page outline when none are found), always at the automatic
   * threshold (the climb in corner-detect.ts). Every detected rectangle is
   * refined further: snap the corners to the full-res contrast boundary,
   * then step 5 px inward so the default crop carries no background sliver.
   * Runs on the first visit of an image (manual = false, silent when nothing
   * is found) and as the second half of the toolbar's Reset.
   */
  protected autoDetect(manual = true): void {
    const img = this.image;
    if (!img || this.mode() !== 'edit') return;
    let found = detectPhotoRects(img);
    if (!found.length) {
      const page = detectPageCorners(img);
      if (page) found = [page];
    }
    if (found.length) {
      this.draft.set([]);
      this.drafting.set(false);
      found = found.map((q) => {
        const snapped = snapCornersToEdges(img, q).map((p) => this.clampToImage(p));
        const inset = insetQuad(sortCorners(snapped), 5);
        return inset ? inset.map((p) => this.clampToImage(p)) : snapped;
      });
      this.quads.set(found);
      this.activeIdx.set(0);
      this.redraw();
    } else if (manual) {
      alert('Could not detect any photos automatically — please click their corners manually.');
    }
  }

  @HostListener('window:resize')
  protected onWindowResize(): void {
    this.relayoutPreview();
  }

  // --- zoom --------------------------------------------------------------

  /** Trackpad pinch (and ctrl/cmd + wheel) zooms the preview under the cursor. */
  protected onWheel(ev: WheelEvent): void {
    if (!ev.ctrlKey && !ev.metaKey) return; // plain scrolling pans the preview
    ev.preventDefault();
    this.applyZoom(this.zoom() * Math.exp(-ev.deltaY * 0.01));
  }

  private applyZoom(z: number): void {
    this.zoom.set(Math.min(Math.max(z, 0.2), 8));
    this.relayoutPreview();
  }

  private resetZoom(): void {
    this.zoom.set(1);
  }

  private relayoutPreview(): void {
    if (this.mode() === 'edit') this.layoutEditCanvas();
    else if (this.mode() === 'result') this.layoutResultCanvas();
  }

  protected layoutResultCanvas(): void {
    const rc = this.resultCanvas().nativeElement;
    const host = this.resultHost().nativeElement;
    const { w, h } = hostContentSize(host);
    if (!rc.width || !rc.height || w <= 0 || h <= 0) return;
    const fit = Math.min(w / rc.width, h / rc.height, 1);
    const z = fit * this.zoom();
    rc.style.width = `${rc.width * z}px`;
    rc.style.height = `${rc.height * z}px`;
  }

  /**
   * Snap each corner of the active rectangle onto the photo's contrast
   * boundary. Progressive: a repeat press within 2 s widens the search box
   * (±25 px → L ±50 → XL ±100, shown as a badge on the button); 2 s of
   * inactivity, a Reset or an image switch drop back to normal. Runs
   * automatically on every newly completed rectangle (auto-detect, fourth
   * click) but never after a manual drag — the loupe exists for deliberate
   * placement, and snapping would fight it.
   */
  protected correctBoundaries(): void {
    const img = this.image;
    const a = this.activeIdx();
    if (!img || this.mode() !== 'edit' || a < 0) return;
    const level = this.snapLevelTimer ? Math.min(this.snapLevel() + 1, SNAP_RADII.length - 1) : 0;
    this.snapLevel.set(level);
    if (this.snapLevelTimer) clearTimeout(this.snapLevelTimer);
    this.snapLevelTimer = setTimeout(() => {
      this.snapLevelTimer = null;
      this.snapLevel.set(0);
    }, SNAP_ESCALATE_MS);
    const before = this.quads()[a];
    // flash the searched areas: the snap looks around the PRE-snap corners
    this.snapFlash = { centers: before.map((p) => ({ ...p })), radius: SNAP_RADII[level] };
    if (this.snapFlashTimer) clearTimeout(this.snapFlashTimer);
    this.snapFlashTimer = setTimeout(() => {
      this.snapFlashTimer = null;
      this.snapFlash = null;
      this.redraw();
    }, SNAP_FLASH_MS);
    const snapped = snapCornersToEdges(img, before, SNAP_RADII[level]).map((p) =>
      this.clampToImage(p),
    );
    this.quads.update((qs) => qs.map((q, i) => (i === a ? snapped : q)));
    this.redraw();
  }

  /** Back to the normal search box: image switched or rectangles reset. */
  private resetSnapLevel(): void {
    if (this.snapLevelTimer) clearTimeout(this.snapLevelTimer);
    this.snapLevelTimer = null;
    this.snapLevel.set(0);
    if (this.snapFlashTimer) clearTimeout(this.snapFlashTimer);
    this.snapFlashTimer = null;
    this.snapFlash = null;
  }

  /** Move every edge of the active rectangle 10 px inward. */
  protected shrinkQuad(): void {
    this.shrinkBy(10);
  }

  private shrinkBy(d: number): void {
    const a = this.activeIdx();
    if (this.mode() !== 'edit' || a < 0 || !this.image) return;
    const inset = insetQuad(sortCorners(this.quads()[a]), d);
    if (inset) {
      const clamped = inset.map((p) => this.clampToImage(p));
      this.quads.update((qs) => qs.map((q, i) => (i === a ? clamped : q)));
      this.redraw();
    }
  }

  /** Delete the in-progress draft, or else the active rectangle. */
  protected deleteActive(): void {
    if (this.mode() !== 'edit') return;
    if (this.drafting()) {
      this.cancelDraft();
      return;
    }
    const a = this.activeIdx();
    if (a < 0) return;
    this.quads.update((qs) => qs.filter((_, i) => i !== a));
    this.activeIdx.set(this.quads().length ? Math.min(a, this.quads().length - 1) : -1);
    this.redraw();
  }

  /** Toggle "add photo" mode; pressing the button while drafting cancels. */
  protected toggleDraft(): void {
    if (this.mode() !== 'edit') return;
    if (this.drafting()) this.cancelDraft();
    else this.drafting.set(true);
  }

  private cancelDraft(): void {
    this.drafting.set(false);
    if (this.draft().length) {
      this.draft.set([]);
      this.redraw();
    }
  }

  // --- speech input -----------------------------------------------------------

  /**
   * Entry point for the mic buttons — a dictaphone toggle: a press starts
   * recording, the next press stops it (and applies what was heard).
   *
   * The first time the browser has not yet granted mic access we explain
   * that some browsers route audio through a cloud speech-to-text service.
   * Pressing Continue only acknowledges the notice — it does NOT start
   * recording; the user presses the mic again to actually begin. Once
   * acknowledged (or the permission is already granted) later presses start
   * straight away.
   */
  protected dictate(target: 'field' | 'scratchpad'): void {
    if (this.listening()) {
      this.stopDictation();
      return;
    }
    if (this.micConsentAcknowledged) {
      this.startDictation(target);
      return;
    }
    void this.isMicGranted().then((granted) => {
      if (granted) {
        this.startDictation(target);
      } else {
        this.pendingDictateTarget = target;
        this.micConsentOpen.set(true);
      }
    });
  }

  /** Resolve to true only when the mic permission is already 'granted'. */
  private async isMicGranted(): Promise<boolean> {
    try {
      const query = navigator.permissions?.query?.bind(navigator.permissions);
      if (!query) return false; // no Permissions API (e.g. Firefox) → explain to be safe
      const status = await query({ name: 'microphone' } as unknown as PermissionDescriptor);
      return status.state === 'granted';
    } catch {
      return false; // 'microphone' descriptor unsupported → explain to be safe
    }
  }

  /** Continue from the consent modal: acknowledge only — do NOT start yet. */
  protected confirmMicConsent(): void {
    this.micConsentAcknowledged = true;
    this.micConsentOpen.set(false);
    this.pendingDictateTarget = null;
    this.setVoiceStatus('Microphone ready — press the mic again to start');
  }

  /** Cancel the consent modal without touching the mic. */
  protected cancelMicConsent(): void {
    this.micConsentOpen.set(false);
    this.pendingDictateTarget = null;
  }

  /** Begin recording; keeps listening until stopDictation() (continuous). */
  private startDictation(target: 'field' | 'scratchpad'): void {
    const w = window as unknown as Record<string, new () => Recognition>;
    const RecognitionCtor = w['SpeechRecognition'] ?? w['webkitSpeechRecognition'];
    if (!RecognitionCtor) {
      alert('Speech recognition is not supported in this browser.');
      return;
    }
    if (this.listening()) return;
    const rec = new RecognitionCtor();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true; // so the status can preview words as they land
    rec.continuous = true; // dictaphone: don't auto-stop on the first pause
    rec.maxAlternatives = 1;
    this.rec = rec;
    this.dictationTarget = target;
    this.dictationText = '';
    this.dictationInterim = '';
    this.dictationErrored = false;
    this.listening.set(true);
    this.setVoiceStatus('Recording — press the mic again to stop', 0);
    rec.onresult = (ev) => {
      // ev.results is cumulative; rebuild the final text and preview interim
      let final = '';
      let interim = '';
      for (let i = 0; i < ev.results.length; i++) {
        const res = ev.results[i];
        const transcript = res[0]?.transcript ?? '';
        if (res.isFinal) final += transcript;
        else interim += transcript;
      }
      this.dictationText = final;
      // keep the not-yet-final tail: releasing right after a sentence often
      // stops before the engine promotes it to a final result, and we still
      // want those words (finishDictation combines final + interim)
      this.dictationInterim = interim;
      const preview = (final + interim).trim();
      this.setVoiceStatus(
        preview ? `Recording: “${preview}”` : 'Recording — press the mic again to stop',
        0,
      );
    };
    rec.onerror = (ev) => {
      this.dictationErrored = true;
      this.setVoiceStatus(`Speech recognition error: ${ev.error}`);
    };
    rec.onend = () => {
      // fires after stop() and after any error; finalize here
      this.listening.set(false);
      this.rec = null;
      if (this.dictationErrored) {
        this.dictationErrored = false;
        this.dictationText = '';
        this.dictationInterim = '';
        return;
      }
      this.finishDictation();
    };
    rec.start();
  }

  /** Stop the active recording; onend then applies what was heard. */
  private stopDictation(): void {
    const rec = this.rec;
    if (!rec) {
      this.listening.set(false);
      return;
    }
    try {
      rec.stop();
    } catch {
      // already stopping — onend will still run
    }
  }

  /** Apply the accumulated transcript to the field or scratchpad. */
  private finishDictation(): void {
    // combine final + any not-yet-final tail so a quick release keeps the last words
    const heard = (this.dictationText + this.dictationInterim).trim();
    this.dictationText = '';
    this.dictationInterim = '';
    if (!heard) {
      this.setVoiceStatus('Heard nothing — try again');
      return;
    }
    if (this.dictationTarget === 'field') this.descriptionField.set(heard);
    else this.addScratchEntry('description', heard);
    this.setVoiceStatus(
      `Heard “${heard}” — description ${this.dictationTarget === 'field' ? 'set' : 'noted'}`,
    );
  }

  private voiceStatusTimer: ReturnType<typeof setTimeout> | undefined;

  private setVoiceStatus(text: string | null, clearAfterMs = 6000): void {
    clearTimeout(this.voiceStatusTimer);
    this.voiceStatus.set(text);
    if (text && clearAfterMs > 0) {
      this.voiceStatusTimer = setTimeout(() => this.voiceStatus.set(null), clearAfterMs);
    }
  }

  // --- scratchpad -------------------------------------------------------------

  private addScratchEntry(kind: 'date' | 'description', value: Date | string): void {
    const entry: ScratchEntry =
      kind === 'date'
        ? {
            id: ++this.scratchId,
            kind,
            dateIso: toIsoDate(value as Date),
            text: (value as Date).toLocaleDateString(undefined, {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            }),
          }
        : { id: ++this.scratchId, kind, text: (value as string).trim() };
    this.scratchpad.update((s) => [...s, entry]);
  }

  /** Add typed text, auto-detecting dates: date-like input goes to the dates list. */
  protected addScratchAuto(raw: string, input: HTMLInputElement): void {
    const text = raw.trim();
    if (!text) return;
    const d = parseSpokenDate(text);
    // only short, date-like texts count as dates; longer sentences that happen
    // to contain a date are still descriptions
    if (d && text.split(/\s+/).length <= 4) {
      this.addScratchEntry('date', d);
      this.setVoiceStatus(`Recognized “${text}” as a date`);
    } else {
      this.addScratchEntry('description', text);
    }
    input.value = '';
    input.focus();
  }

  /** Add typed text to the scratchpad; dates are parsed like spoken ones. */
  protected addScratchText(
    kind: 'date' | 'description',
    raw: string,
    input: HTMLInputElement,
  ): void {
    const text = raw.trim();
    if (!text) return;
    if (kind === 'date') {
      const d = parseSpokenDate(text);
      if (!d) {
        this.setVoiceStatus(`“${text}” is not a recognizable date`);
        return;
      }
      this.addScratchEntry('date', d);
    } else {
      this.addScratchEntry('description', text);
    }
    input.value = '';
    input.focus(); // ready for the next entry
  }

  protected removeScratch(id: number): void {
    this.scratchpad.update((s) => s.filter((e) => e.id !== id));
  }

  protected clearScratchpad(): void {
    this.scratchpad.set([]);
  }

  protected toggleScratchpad(): void {
    this.scratchCollapsed.update((c) => !c);
    // expanding brings the tune histogram (back) into the DOM
    if (!this.scratchCollapsed()) this.scheduleHistogramDraw();
  }

  /**
   * Use a scratchpad entry as the current date or description. Every plain
   * use of a date advances its time by one second (12:00:00, 12:00:01, …) so
   * photos sharing a date keep a stable chronological order. A `dayOffset`
   * applies the date shifted by whole days (the chips' "+1d" mini-button) —
   * that is a different day, so it stamps a plain 12:00:00 and leaves the
   * entry's use counter alone. Only meaningful on the result screen — the
   * panel is always visible, but the metadata fields are not, so a chip
   * click elsewhere does nothing.
   */
  protected applyScratch(entry: ScratchEntry, dayOffset = 0): void {
    if (this.mode() !== 'result') return;
    if (entry.kind === 'date' && entry.dateIso) {
      if (dayOffset) {
        this.dateField.set(addDaysIso(entry.dateIso, dayOffset));
        this.timeField.set(DEFAULT_TIME);
        return;
      }
      const used = entry.used ?? 0;
      this.dateField.set(entry.dateIso);
      this.timeField.set(secondsToTime(12 * 3600 + used));
      this.scratchpad.update((s) =>
        s.map((e) => (e.id === entry.id ? { ...e, used: used + 1 } : e)),
      );
    } else if (entry.kind === 'description') {
      this.descriptionField.set(entry.text);
    }
  }

  // --- image tune (result screen) ---------------------------------------------

  /** Non-neutral levels on a channel: shown as a dot on its selector button. */
  protected channelTuned(c: TuneChannel): boolean {
    return !isNeutralLevels(this.tune().levels[c]);
  }

  protected setTuneChannel(c: TuneChannel): void {
    this.editingTuneField.set(null); // a levels edit belongs to the channel it was opened on
    this.tuneChannel.set(c);
    this.scheduleHistogramDraw();
  }

  protected onTuneLevel(part: 'black' | 'gamma' | 'white', ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const raw = +input.value;
    const ch = this.tuneChannel();
    this.updateTune((t) => {
      const cur = t.levels[ch];
      let l: ChannelLevels;
      if (part === 'gamma') {
        l = { ...cur, gamma: Math.round(Math.pow(10, raw / 100) * 100) / 100 };
      } else if (part === 'black') {
        l = { ...cur, black: Math.min(raw, cur.white - 1) };
      } else {
        l = { ...cur, white: Math.max(raw, cur.black + 1) };
      }
      // black and white clamp against each other; push the thumb back too —
      // the [value] binding alone won't move it when the clamped value is
      // unchanged from the previous state
      if (part !== 'gamma' && l[part] !== raw) input.value = String(l[part]);
      return { ...t, levels: { ...t.levels, [ch]: l } };
    });
  }

  protected onTuneBC(part: 'brightness' | 'contrast', ev: Event): void {
    const v = +(ev.target as HTMLInputElement).value;
    this.updateTune((t) => ({ ...t, [part]: v }));
  }

  /** Turn a slider readout into a text input and focus it (click-to-type). */
  protected startEditTuneField(field: TuneNumField): void {
    this.editingTuneField.set(field);
    this.tuneEditCanceled = false;
    // remember the pre-edit tune so a cancel can undo the live edits
    this.tuneEditSnapshot = structuredClone(this.tune());
    requestAnimationFrame(() => {
      const el = this.tuneNumInput()?.nativeElement;
      if (!el) return;
      // seed the value imperatively — the input has no [value] binding on
      // purpose, so live-applying while typing can't rewrite the caret away
      el.value = this.tuneFieldText(field);
      el.focus();
      el.select();
    });
  }

  /** The current value of a tune field, formatted as its readout shows it. */
  private tuneFieldText(field: TuneNumField): string {
    switch (field) {
      case 'black':
        return String(this.tuneLevels().black);
      case 'white':
        return String(this.tuneLevels().white);
      case 'gamma':
        return this.tuneLevels().gamma.toFixed(2);
      case 'brightness':
        return String(this.tune().brightness);
      case 'contrast':
        return String(this.tune().contrast);
    }
  }

  /** Keep the input to the characters this field allows (digits, plus sign
      for the signed fields and one dot for gamma) — no letters, no `e` —
      then apply the value live, debounced 200 ms. */
  protected onTuneNumInput(ev: Event): void {
    const field = this.editingTuneField();
    if (!field) return;
    const input = ev.target as HTMLInputElement;
    input.value = filterTuneNumInput(input.value, field);
    const raw = input.value.trim();
    clearTimeout(this.tuneEditTimer);
    this.tuneEditTimer = window.setTimeout(() => {
      if (this.editingTuneField() !== field) return; // edit ended meanwhile
      const n = Number(raw);
      if (raw !== '' && raw !== '-' && raw !== '.' && Number.isFinite(n)) {
        this.applyTuneNumber(field, n);
      }
    }, 200);
  }

  protected onTuneNumKeydown(ev: KeyboardEvent): void {
    if (ev.key !== 'Enter' && ev.key !== 'Escape') return;
    // keep the global shortcut listener out of it — Enter would confirm the
    // save phase, Escape would leave the result screen
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.key === 'Escape') this.tuneEditCanceled = true;
    (ev.target as HTMLInputElement).blur(); // (blur) commits or, if canceled, discards
  }

  /** Commit the typed value (clamped to the slider's range) and close the
      editor. Escape, or leaving it blank/unparseable, reverts to the
      pre-edit tune — undoing whatever the live debounce already applied. */
  protected commitTuneField(ev: Event): void {
    clearTimeout(this.tuneEditTimer);
    const field = this.editingTuneField();
    this.editingTuneField.set(null);
    const snapshot = this.tuneEditSnapshot;
    this.tuneEditSnapshot = null;
    const raw = (ev.target as HTMLInputElement).value.trim();
    const n = Number(raw);
    const revert = this.tuneEditCanceled || raw === '' || !Number.isFinite(n);
    this.tuneEditCanceled = false;
    if (revert) {
      if (snapshot) this.updateTune(() => snapshot);
      return;
    }
    if (field) this.applyTuneNumber(field, n);
  }

  /** Apply a typed number to its tune field, clamped like its slider. */
  private applyTuneNumber(field: TuneNumField, n: number): void {
    if (field === 'brightness' || field === 'contrast') {
      this.updateTune((t) => ({ ...t, [field]: clamp(Math.round(n), -100, 100) }));
      return;
    }
    const ch = this.tuneChannel();
    this.updateTune((t) => {
      const cur = t.levels[ch];
      let l: ChannelLevels;
      if (field === 'gamma') {
        l = { ...cur, gamma: clamp(n, 0.1, 10) };
      } else if (field === 'black') {
        // black and white clamp against each other, same as the sliders
        l = { ...cur, black: clamp(Math.round(n), 0, cur.white - 1) };
      } else {
        l = { ...cur, white: clamp(Math.round(n), cur.black + 1, 255) };
      }
      return { ...t, levels: { ...t.levels, [ch]: l } };
    });
  }

  protected resetTune(): void {
    this.updateTune(() => defaultTune());
  }

  protected toggleTunePreview(): void {
    this.tunePreview.update((v) => !v);
    this.applyTuneNow();
  }

  /** Copy the last configured (non-neutral) tune onto the current photo. */
  protected useLastTune(): void {
    const t = this.lastTune();
    if (t) this.updateTune(() => structuredClone(t));
  }

  protected applyTunePreset(p: TunePreset): void {
    this.updateTune(() => structuredClone(p.tune));
  }

  protected removeTunePreset(id: number, ev: Event): void {
    ev.stopPropagation();
    this.tunePresets.update((list) => list.filter((p) => p.id !== id));
  }

  protected openPresetModal(): void {
    this.presetModalOpen.set(true);
    // focus after the modal has rendered
    requestAnimationFrame(() => this.presetNameInput()?.nativeElement.focus());
  }

  /** Save the current tune under a name; the same name overwrites its preset. */
  protected saveTunePreset(raw: string): void {
    const name = raw.trim().slice(0, 40);
    if (!name) return;
    const tune = structuredClone(this.tune());
    this.tunePresets.update((list) =>
      list.some((p) => p.name === name)
        ? list.map((p) => (p.name === name ? { ...p, tune } : p))
        : [...list, { id: ++this.presetId, name, tune }],
    );
    this.presetModalOpen.set(false);
  }

  /** Update the shown photo's tune, keep the per-photo store in sync, redraw. */
  private updateTune(patch: (t: Tune) => Tune): void {
    if (this.mode() !== 'result') return;
    const t = patch(this.tune());
    this.tune.set(t);
    this.tunes[this.resultIndex()] = t;
    // remember the last real configuration for "use previous" on later
    // photos; a reset to neutral does not forget it
    if (!isNeutralTune(t)) this.lastTune.set(t);
    // a slider moved while the eye is off would look dead — turn it back on
    this.tunePreview.set(true);
    this.applyTuneSoon();
  }

  /** Coalesce slider drags to one LUT pass per frame. */
  private applyTuneSoon(): void {
    if (this.tuneRaf) return;
    this.tuneRaf = requestAnimationFrame(() => {
      this.tuneRaf = 0;
      this.applyTuneNow();
    });
  }

  /**
   * Bake the current tune into the visible result canvas. Saving reads that
   * canvas (toBlob), so the exported JPEG carries the tuned pixels without
   * any extra save-path work; results[] keeps the untuned original so
   * adjustments stay non-destructive.
   */
  private applyTuneNow(): void {
    if (this.mode() !== 'result') return;
    const idx = this.resultIndex();
    const src = this.results[idx];
    if (!src) return;
    const rc = this.resultCanvas().nativeElement;
    const ctx = rc.getContext('2d')!;
    const t = this.tune();
    if (!this.tunePreview()) {
      ctx.drawImage(src, 0, 0);
      return; // eye off: the strip thumb keeps showing the tuned pixels
    }
    if (isNeutralTune(t)) {
      ctx.drawImage(src, 0, 0);
    } else {
      const data = this.ensureTuneSrc();
      if (!data) return;
      if (
        !this.tuneDst ||
        this.tuneDst.width !== data.width ||
        this.tuneDst.height !== data.height
      ) {
        this.tuneDst = new ImageData(data.width, data.height);
      }
      applyTune(data, this.tuneDst, t);
      ctx.putImageData(this.tuneDst, 0, 0);
    }
    // keep the strip thumbnail in sync with the tuned pixels
    if (this.resultCount() > 1) {
      this.resultThumbs.update((th) => th.map((v, i) => (i === idx ? resultThumb(rc) : v)));
    }
  }

  private ensureTuneSrc(): ImageData | null {
    const src = this.results[this.resultIndex()];
    if (!src) return null;
    if (!this.tuneSrc) {
      this.tuneSrc = src
        .getContext('2d', { willReadFrequently: true })!
        .getImageData(0, 0, src.width, src.height);
    }
    return this.tuneSrc;
  }

  /** Photo switched or rotated: cached pixels and histograms are stale. */
  private invalidateTuneCache(): void {
    this.tuneSrc = null;
    this.tuneDst = null;
    this.histograms.clear();
    if (this.tuneRaf) {
      cancelAnimationFrame(this.tuneRaf);
      this.tuneRaf = 0;
    }
  }

  /** Draw after the next render — the canvas may not be in the DOM yet. */
  private scheduleHistogramDraw(): void {
    requestAnimationFrame(() => this.drawHistogram());
  }

  private drawHistogram(): void {
    const el = this.histCanvas()?.nativeElement;
    if (!el || this.mode() !== 'result') return;
    const ch = this.tuneChannel();
    let bins = this.histograms.get(ch);
    if (!bins) {
      const src = this.ensureTuneSrc();
      if (!src) return;
      bins = tuneHistogram(src, ch);
      this.histograms.set(ch, bins);
    }
    // one backing-store column per bin; CSS stretches it to the panel width
    const W = 256;
    const H = 64;
    if (el.width !== W || el.height !== H) {
      el.width = W;
      el.height = H;
    }
    const ctx = el.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    let max = 1;
    for (let i = 0; i < 256; i++) if (bins[i] > max) max = bins[i];
    ctx.fillStyle =
      ch === 'r' ? '#f87171' : ch === 'g' ? '#4ade80' : ch === 'b' ? '#60a5fa' : '#94a3b8';
    for (let x = 0; x < 256; x++) {
      const h = Math.round((bins[x] / max) * H);
      if (h) ctx.fillRect(x, H - h, 1, h);
    }
  }

  protected backToEdit(): void {
    this.results = []; // discard pending rectified photos
    this.resultCount.set(0);
    this.resultThumbs.set([]);
    this.resultStatus.set([]);
    this.tunes = [];
    this.tune.set(defaultTune());
    this.invalidateTuneCache();
    this.resetZoom();
    this.mode.set('edit');
    requestAnimationFrame(() => this.layoutEditCanvas());
  }

  /** The browser Back button leaves the result screen exactly like Esc. */
  @HostListener('window:popstate')
  protected onPopState(): void {
    if (this.mode() === 'result') this.backToEdit();
  }

  // --- rotation --------------------------------------------------------------

  /** Platform-aware label for the confirm shortcut, used in tooltips. */
  protected readonly confirmKey = /mac/i.test(navigator.userAgent) ? '⌘+Enter' : 'Alt+Enter';
  /** Platform-aware prefix for the preset shortcuts (⌘1 / Ctrl+1). */
  protected readonly presetKeyPrefix = /mac/i.test(navigator.userAgent) ? '⌘' : 'Ctrl+';

  @HostListener('window:keydown', ['$event'])
  protected onKeyDown(ev: KeyboardEvent): void {
    // the modals and the collection page capture Escape first
    if (ev.key === 'Escape' && this.settingsOpen()) {
      this.settingsOpen.set(false);
      return;
    }
    if (ev.key === 'Escape' && this.presetModalOpen()) {
      this.presetModalOpen.set(false);
      return;
    }
    if (ev.key === 'Escape' && this.micConsentOpen()) {
      this.cancelMicConsent();
      return;
    }
    if (ev.key === 'Escape' && this.mode() === 'collection') {
      this.backFromCollection();
      return;
    }
    // Alt/Cmd+Enter confirms the current phase: apply or save.
    // Checked before the input guard so it also works while typing metadata.
    if (ev.key === 'Enter' && (ev.altKey || ev.metaKey)) {
      ev.preventDefault();
      if (this.mode() === 'edit') void this.apply();
      else if (this.mode() === 'result') this.save();
      return;
    }

    // Ctrl/Cmd +/-/0 zoom the active preview instead of the whole page
    if ((ev.metaKey || ev.ctrlKey) && ['edit', 'result'].includes(this.mode())) {
      if (ev.key === '+' || ev.key === '=') {
        ev.preventDefault();
        this.applyZoom(this.zoom() * 1.25);
        return;
      }
      if (ev.key === '-' || ev.key === '_') {
        ev.preventDefault();
        this.applyZoom(this.zoom() / 1.25);
        return;
      }
      if (ev.key === '0') {
        ev.preventDefault();
        this.applyZoom(1);
        return;
      }
    }

    // Ctrl/Cmd+1..5 apply the first five tune presets on the result screen;
    // checked before the input guard so they work while typing metadata
    if ((ev.metaKey || ev.ctrlKey) && this.mode() === 'result' && ev.key >= '1' && ev.key <= '5') {
      const preset = this.tunePresets()[+ev.key - 1];
      if (preset) {
        ev.preventDefault();
        this.applyTunePreset(preset);
      }
      return;
    }

    const target = ev.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    ) {
      // Escape steps out of the field; a second Escape then leaves the screen
      if (ev.key === 'Escape') target.blur();
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

    // Escape cancels an in-progress rectangle in the editor
    if (ev.key === 'Escape' && this.mode() === 'edit' && this.drafting()) {
      this.cancelDraft();
      return;
    }

    // Escape or Backspace returns from the result screen to the corner
    // editor (the input guard above keeps Backspace deleting text in the
    // metadata fields)
    if ((ev.key === 'Escape' || ev.key === 'Backspace') && this.mode() === 'result') {
      ev.preventDefault();
      this.backToEdit();
      return;
    }

    if (this.mode() === 'edit') {
      if (ev.key === 'ArrowLeft') {
        ev.preventDefault();
        void this.openImage(this.currentIndex() - 1);
        return;
      }
      if (ev.key === 'ArrowRight') {
        ev.preventDefault();
        void this.openImage(this.currentIndex() + 1);
        return;
      }
    }

    // on the result screen the arrows step through the rectified photos
    if (this.mode() === 'result') {
      if (ev.key === 'ArrowLeft') {
        ev.preventDefault();
        this.goToResult(this.resultIndex() - 1);
        return;
      }
      if (ev.key === 'ArrowRight') {
        ev.preventDefault();
        this.goToResult(this.resultIndex() + 1);
        return;
      }
    }

    const key = ev.key.toLowerCase();
    if (key === 'r') void this.rotate(1);
    else if (key === 'l') void this.rotate(-1);
    else if (key === 's' && this.mode() === 'edit') this.shrinkQuad();
    else if (key === 'c' && this.mode() === 'edit') this.correctBoundaries();
    else if ((ev.key === 'Delete' || ev.key === 'Backspace') && this.mode() === 'edit') {
      this.deleteActive();
    } else if (this.mode() === 'result') {
      // tune panel: B = before/after eye (pointless on a neutral tune —
      // button disabled), U = use last settings
      if (key === 'b' && !this.tuneNeutral()) this.toggleTunePreview();
      else if (key === 'u') this.useLastTune();
    }
  }

  /** Rotate the current image by 90°; dir 1 = clockwise (right), -1 = counter-clockwise (left). */
  protected async rotate(dir: 1 | -1): Promise<void> {
    if (this.rotating) return;
    this.rotating = true;
    try {
      if (this.mode() === 'edit') await this.rotateEditImage(dir);
      else if (this.mode() === 'result') this.rotateResult(dir);
    } finally {
      this.rotating = false;
    }
  }

  private async rotateEditImage(dir: 1 | -1): Promise<void> {
    const img = this.image;
    if (!img) return;
    const oldW = img.width;
    const oldH = img.height;
    const c = document.createElement('canvas');
    c.width = oldH;
    c.height = oldW;
    const ctx = c.getContext('2d')!;
    if (dir === 1) {
      ctx.translate(oldH, 0);
      ctx.rotate(Math.PI / 2);
    } else {
      ctx.translate(0, oldW);
      ctx.rotate(-Math.PI / 2);
    }
    ctx.drawImage(img, 0, 0);
    const rotated = await createImageBitmap(c);
    img.close();
    this.image = rotated;
    // carry the already-placed rectangles and draft corners along with the rotation
    const mapPt = (p: Point) => (dir === 1 ? { x: oldH - p.y, y: p.x } : { x: p.y, y: oldW - p.x });
    this.quads.update((qs) => qs.map((q) => q.map(mapPt)));
    this.draft.update((ds) => ds.map(mapPt));
    // renumber for the new orientation: the crop-order bubbles and the
    // "photo i / n" counter always read top-left first, bottom-right last
    const active = this.activeIdx() >= 0 ? this.quads()[this.activeIdx()] : null;
    const ordered = readingOrder(this.quads(), rotated.height);
    this.quads.set(ordered);
    if (active) this.activeIdx.set(ordered.indexOf(active));
    // persist the rotation on the queue item and refresh its thumbnail
    const idx = this.currentIndex();
    if (this.images()[idx]) {
      const rotation = (this.images()[idx].rotation + (dir === 1 ? 90 : 270)) % 360;
      const thumb = this.thumbFromBitmap(rotated);
      this.images.update((list) =>
        list.map((it, i) => (i === idx ? { ...it, rotation, thumb } : it)),
      );
    }
    this.layoutEditCanvas();
  }

  private rotateResult(dir: 1 | -1): void {
    // rotate the stored result, not just the visible canvas, so the rotation
    // survives navigating to another photo and back, and the strip thumbnail
    // stays in sync
    const idx = this.resultIndex();
    const src = this.results[idx];
    if (!src) return;
    const tmp = document.createElement('canvas');
    tmp.width = src.height;
    tmp.height = src.width;
    const tctx = tmp.getContext('2d')!;
    if (dir === 1) {
      tctx.translate(src.height, 0);
      tctx.rotate(Math.PI / 2);
    } else {
      tctx.translate(0, src.width);
      tctx.rotate(-Math.PI / 2);
    }
    tctx.drawImage(src, 0, 0);
    this.results[idx] = tmp;
    this.resultThumbs.update((t) => t.map((v, i) => (i === idx ? resultThumb(tmp) : v)));
    const rc = this.resultCanvas().nativeElement;
    rc.width = tmp.width;
    rc.height = tmp.height;
    rc.getContext('2d')!.drawImage(tmp, 0, 0);
    // the rotation swapped the cached tune pixels' dimensions; re-bake the
    // tune (values are orientation-independent, so the histogram is not stale)
    this.invalidateTuneCache();
    if (!this.tuneNeutral()) this.applyTuneNow();
    this.outSize.set({ w: tmp.width, h: tmp.height });
    this.layoutResultCanvas();
  }

  // --- corner editing on the canvas ---------------------------------------

  protected onPointerDown(ev: PointerEvent): void {
    if (this.mode() !== 'edit' || !this.image) return;
    const p = this.toImagePoint(ev);
    const hit = this.hitCorner(p);
    if (hit) {
      this.dragKind = hit.kind;
      this.dragIndex = hit.idx;
      this.editCanvas().nativeElement.setPointerCapture(ev.pointerId);
      this.loupeVisible.set(true);
      const pts = hit.kind === 'draft' ? this.draft() : this.quads()[this.activeIdx()];
      this.updateLoupe(ev, pts[hit.idx]);
      return;
    }
    // while drafting, only draft corners are interactive: edge grips and
    // rectangle activation must not swallow the clicks that place corners
    if (!this.drafting()) {
      const edge = this.hitEdgeHandle(p);
      if (edge) {
        this.edgeDrag = edge;
        this.editCanvas().nativeElement.setPointerCapture(ev.pointerId);
        return;
      }
      // clicking inside another rectangle activates it
      const qi = this.quadAt(p);
      if (qi >= 0 && qi !== this.activeIdx()) {
        this.activeIdx.set(qi);
        this.redraw();
        return;
      }
    }
    // empty area: drag pans the view; while drafting, a plain click (below
    // the movement threshold) still places a draft corner on release
    const host = this.canvasHost().nativeElement;
    this.editPan = {
      clientX: ev.clientX,
      clientY: ev.clientY,
      scrollLeft: host.scrollLeft,
      scrollTop: host.scrollTop,
      moved: false,
      imgPoint: p,
    };
    this.editCanvas().nativeElement.setPointerCapture(ev.pointerId);
  }

  protected onPointerMove(ev: PointerEvent): void {
    if (this.mode() !== 'edit' || !this.image) return;
    if (this.dragIndex >= 0) {
      const p = this.clampToImage(this.toImagePoint(ev));
      const idx = this.dragIndex;
      if (this.dragKind === 'draft') {
        this.draft.update((c) => c.map((q, i) => (i === idx ? p : q)));
      } else {
        const a = this.activeIdx();
        this.quads.update((qs) =>
          qs.map((q, qi) => (qi === a ? q.map((pt, i) => (i === idx ? p : pt)) : q)),
        );
      }
      this.redraw();
      this.updateLoupe(ev, p);
    } else if (this.editPan) {
      const pan = this.editPan;
      const dx = ev.clientX - pan.clientX;
      const dy = ev.clientY - pan.clientY;
      if (!pan.moved && Math.hypot(dx, dy) > 4) pan.moved = true;
      if (pan.moved) {
        const host = this.canvasHost().nativeElement;
        host.scrollLeft = pan.scrollLeft - dx;
        host.scrollTop = pan.scrollTop - dy;
        this.editCanvas().nativeElement.style.cursor = 'grabbing';
      }
    } else if (this.edgeDrag) {
      const d = this.edgeDrag;
      const p = this.toImagePoint(ev);
      // project the pointer movement onto the edge normal (the slider axis)
      let t = (p.x - d.startPointer.x) * d.normal.x + (p.y - d.startPointer.y) * d.normal.y;
      t = Math.min(Math.max(t, d.tMin), d.tMax);
      const movedA = { x: d.startA.x + t * d.normal.x, y: d.startA.y + t * d.normal.y };
      const movedB = { x: d.startB.x + t * d.normal.x, y: d.startB.y + t * d.normal.y };
      const a = this.activeIdx();
      this.quads.update((qs) =>
        qs.map((q, qi) =>
          qi === a ? q.map((pt, i) => (i === d.rawA ? movedA : i === d.rawB ? movedB : pt)) : q,
        ),
      );
      this.redraw();
    } else {
      const canvas = this.editCanvas().nativeElement;
      const p = this.toImagePoint(ev);
      if (this.drafting()) {
        canvas.style.cursor = this.hitCorner(p) ? 'move' : 'crosshair';
        return;
      }
      const qi = this.quadAt(p);
      const edge = this.hitEdgeHandle(p);
      canvas.style.cursor = this.hitCorner(p)
        ? 'move'
        : edge
          ? this.edgeResizeCursor(edge.normal)
          : qi >= 0 && qi !== this.activeIdx()
            ? 'pointer'
            : 'grab';
    }
  }

  protected onPointerUp(ev: PointerEvent): void {
    if (this.editPan) {
      if (!this.editPan.moved && this.drafting()) {
        const p = this.clampToImage(this.editPan.imgPoint);
        this.draft.update((c) => [...c, p]);
        // the fourth click completes a rectangle — make it active and snap it
        if (this.draft().length === 4) {
          const quad = this.draft();
          this.draft.set([]);
          this.drafting.set(false);
          this.quads.update((qs) => [...qs, quad]);
          this.activeIdx.set(this.quads().length - 1);
          this.correctBoundaries();
        }
        this.redraw();
      }
      this.editPan = null;
      this.editCanvas().nativeElement.style.cursor = '';
      this.editCanvas().nativeElement.releasePointerCapture(ev.pointerId);
      return;
    }
    if (this.dragIndex >= 0 || this.edgeDrag) {
      this.dragIndex = -1;
      this.edgeDrag = null;
      this.loupeVisible.set(false);
      this.editCanvas().nativeElement.releasePointerCapture(ev.pointerId);
    }
  }

  /**
   * Precision loupe while dragging a corner: a circular magnifier next to the
   * pointer showing the full-resolution image around the corner, crosshair at
   * the exact corner position.
   */
  private updateLoupe(ev: PointerEvent, center: Point): void {
    const img = this.image;
    if (!img) return;
    const el = this.loupeCanvas().nativeElement;
    const D = 150; // CSS diameter
    const dpr = window.devicePixelRatio || 1;
    if (el.width !== D * dpr || el.height !== D * dpr) {
      el.width = D * dpr;
      el.height = D * dpr;
    }
    // always magnify well beyond the fitted view; at least 2 CSS px per image px
    const scale = Math.max(2, this.viewScale * 2.5);
    const srcSize = D / scale;
    const ctx = el.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false; // show real pixels for precise placement
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, el.width, el.height);
    ctx.drawImage(
      img,
      center.x - srcSize / 2,
      center.y - srcSize / 2,
      srcSize,
      srcSize,
      0,
      0,
      el.width,
      el.height,
    );
    // outer crosshair lines pointing at the center
    const mid = el.width / 2;
    const gap = 10 * dpr;
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.95)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(mid, 0);
    ctx.lineTo(mid, mid - gap);
    ctx.moveTo(mid, mid + gap);
    ctx.lineTo(mid, el.height);
    ctx.moveTo(0, mid);
    ctx.lineTo(mid - gap, mid);
    ctx.moveTo(mid + gap, mid);
    ctx.lineTo(el.width, mid);
    ctx.stroke();
    // fine center cross marking the exact drop point, white underlay for
    // contrast on any image content
    const arm = 9 * dpr;
    const cross = () => {
      ctx.beginPath();
      ctx.moveTo(mid - arm, mid);
      ctx.lineTo(mid + arm, mid);
      ctx.moveTo(mid, mid - arm);
      ctx.lineTo(mid, mid + arm);
      ctx.stroke();
    };
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 3 * dpr;
    cross();
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 1 * dpr;
    cross();
    // follow the pointer, above it by default, below when near the top edge
    const margin = 22;
    const left = Math.min(Math.max(ev.clientX - D / 2, 8), window.innerWidth - D - 8);
    let top = ev.clientY - D - margin;
    if (top < 8) top = ev.clientY + margin;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  // drag-to-pan for the result and info previews
  protected startPan(ev: PointerEvent): void {
    const el = ev.currentTarget as HTMLElement;
    this.hostPan = { x: ev.clientX, y: ev.clientY, left: el.scrollLeft, top: el.scrollTop, el };
    el.setPointerCapture(ev.pointerId);
    el.style.cursor = 'grabbing';
  }

  protected movePan(ev: PointerEvent): void {
    const pan = this.hostPan;
    if (!pan) return;
    pan.el.scrollLeft = pan.left - (ev.clientX - pan.x);
    pan.el.scrollTop = pan.top - (ev.clientY - pan.y);
  }

  protected endPan(ev: PointerEvent): void {
    const pan = this.hostPan;
    if (!pan) return;
    pan.el.releasePointerCapture(ev.pointerId);
    pan.el.style.cursor = '';
    this.hostPan = null;
  }

  /** Reset: drop every rectangle, then run the automatic detection afresh. */
  protected resetRectangles(): void {
    this.quads.set([]);
    this.draft.set([]);
    this.drafting.set(false);
    this.activeIdx.set(-1);
    this.resetSnapLevel();
    this.redraw(); // keep the canvas honest even when detection finds nothing
    this.autoDetect();
  }

  private toImagePoint(ev: PointerEvent): Point {
    return { x: ev.offsetX / this.viewScale, y: ev.offsetY / this.viewScale };
  }

  private clampToImage(p: Point): Point {
    const img = this.image!;
    return {
      x: Math.min(Math.max(p.x, 0), img.width),
      y: Math.min(Math.max(p.y, 0), img.height),
    };
  }

  /**
   * Hit-test the edge sliders (diamond grips at each line's midpoint) and,
   * when hit, prepare a drag that translates the whole line along its normal.
   */
  private hitEdgeHandle(p: Point): EdgeDrag | null {
    const a0 = this.activeIdx();
    if (a0 < 0 || !this.image) return null;
    const pts = this.quads()[a0];
    const sorted = sortCorners(pts);
    const radius = HIT_RADIUS_CSS_PX / this.viewScale;
    for (let i = 0; i < 4; i++) {
      const a = sorted[i];
      const b = sorted[(i + 1) % 4];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (Math.hypot(p.x - mid.x, p.y - mid.y) > radius) continue;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-9) continue;
      const normal = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
      const [tMin, tMax] = this.edgeTranslationRange(a, b, normal);
      return {
        rawA: pts.indexOf(a),
        rawB: pts.indexOf(b),
        startA: { ...a },
        startB: { ...b },
        normal,
        startPointer: p,
        tMin,
        tMax,
      };
    }
    return null;
  }

  /**
   * Resize cursor matching the axis an edge grip slides along (its normal),
   * bucketed to 45° so perspective-skewed edges still get a sensible arrow.
   * Corners live in rotated-image pixels and viewScale is uniform, so an
   * image-space direction is also the on-screen direction.
   */
  private edgeResizeCursor(n: Point): string {
    const deg = ((Math.atan2(n.y, n.x) * 180) / Math.PI + 180) % 180;
    if (deg < 22.5 || deg >= 157.5) return 'ew-resize';
    if (deg < 67.5) return 'nwse-resize';
    if (deg < 112.5) return 'ns-resize';
    return 'nesw-resize';
  }

  /** How far the edge may slide along its normal before a corner leaves the image. */
  private edgeTranslationRange(a: Point, b: Point, n: Point): [number, number] {
    const img = this.image!;
    let tMin = -Infinity;
    let tMax = Infinity;
    for (const c of [a, b]) {
      for (const [pos, comp, max] of [
        [c.x, n.x, img.width],
        [c.y, n.y, img.height],
      ]) {
        if (Math.abs(comp) < 1e-9) continue;
        const t1 = (0 - pos) / comp;
        const t2 = (max - pos) / comp;
        tMin = Math.max(tMin, Math.min(t1, t2));
        tMax = Math.min(tMax, Math.max(t1, t2));
      }
    }
    return [tMin, tMax];
  }

  /** Nearest draggable corner: draft corners first, then the active rectangle's. */
  private hitCorner(p: Point): { kind: 'quad' | 'draft'; idx: number } | null {
    const radius = HIT_RADIUS_CSS_PX / this.viewScale;
    const nearest = (pts: Point[]): number => {
      let best = -1;
      let bestDist = radius;
      pts.forEach((c, i) => {
        const d = Math.hypot(c.x - p.x, c.y - p.y);
        if (d <= bestDist) {
          best = i;
          bestDist = d;
        }
      });
      return best;
    };
    const di = nearest(this.draft());
    if (di >= 0) return { kind: 'draft', idx: di };
    // while drafting, only the draft's own corners are draggable
    if (this.drafting()) return null;
    const a = this.activeIdx();
    if (a >= 0) {
      const qi = nearest(this.quads()[a]);
      if (qi >= 0) return { kind: 'quad', idx: qi };
    }
    return null;
  }

  /** Smallest rectangle containing the point (so overlapped ones stay reachable). */
  private quadAt(p: Point): number {
    let best = -1;
    let bestArea = Infinity;
    this.quads().forEach((q, i) => {
      const s = sortCorners(q);
      let inside = true;
      let area = 0;
      for (let e = 0; e < 4; e++) {
        const a = s[e];
        const b = s[(e + 1) % 4];
        // TL->TR->BR->BL winds clockwise in y-down coords: interior is cross >= 0
        if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) < 0) inside = false;
        area += a.x * b.y - b.x * a.y;
      }
      area = Math.abs(area) / 2;
      if (inside && area < bestArea) {
        best = i;
        bestArea = area;
      }
    });
    return best;
  }

  // --- drawing --------------------------------------------------------------

  private layoutEditCanvas(): void {
    const img = this.image;
    if (!img) return;
    const host = this.canvasHost().nativeElement;
    const canvas = this.editCanvas().nativeElement;
    const { w: cw, h: ch } = hostContentSize(host);
    if (cw <= 0 || ch <= 0) return;
    this.viewScale = Math.min(cw / img.width, ch / img.height) * this.zoom();
    const cssW = img.width * this.viewScale;
    const cssH = img.height * this.viewScale;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    // backing store: sharp up to the source resolution, capped for memory
    const dpr = window.devicePixelRatio || 1;
    this.renderScale = Math.min(this.viewScale * dpr, 1, 8192 / Math.max(img.width, img.height));
    canvas.width = Math.max(1, Math.round(img.width * this.renderScale));
    canvas.height = Math.max(1, Math.round(img.height * this.renderScale));
    this.redraw();
  }

  private redraw(): void {
    const img = this.image;
    if (!img) return;
    const canvas = this.editCanvas().nativeElement;
    const ctx = canvas.getContext('2d')!;
    const s = this.renderScale;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, img.width, img.height);
    ctx.drawImage(img, 0, 0);

    const active = this.activeIdx();
    const many = this.quads().length > 1; // a lone rectangle needs no number
    this.quads().forEach((q, i) => this.drawQuad(ctx, q, i === active, many ? i + 1 : 0));

    // snap search-area flash: where "Correct boundaries" just looked (the
    // radius is in image pixels — the snap runs at full resolution).
    // Deliberately faint — a hint for the fijnproevers, not a spotlight.
    if (this.snapFlash) {
      const { centers, radius } = this.snapFlash;
      ctx.setLineDash([3 / this.viewScale, 5 / this.viewScale]);
      ctx.lineWidth = 1 / this.viewScale;
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.35)';
      for (const c of centers) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, radius, 0, 2 * Math.PI);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // in-progress draft corners
    const pts = this.draft();
    if (!pts.length) return;
    if (pts.length > 1) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.lineWidth = 2 / this.viewScale;
      ctx.strokeStyle = '#22d3ee';
      ctx.stroke();
    }
    this.drawCornerDots(ctx, pts);
  }

  private drawQuad(ctx: CanvasRenderingContext2D, q: Point[], isActive: boolean, n: number): void {
    // connect in visual order so edges never cross
    const order = sortCorners(q);
    ctx.beginPath();
    ctx.moveTo(order[0].x, order[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(order[i].x, order[i].y);
    ctx.closePath();
    ctx.fillStyle = isActive ? 'rgba(34, 211, 238, 0.12)' : 'rgba(34, 211, 238, 0.04)';
    ctx.fill();
    if (!isActive) {
      ctx.setLineDash([6 / this.viewScale, 4 / this.viewScale]);
      ctx.lineWidth = 1.5 / this.viewScale;
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.55)';
      ctx.stroke();
      ctx.setLineDash([]);
      this.drawQuadNumber(ctx, order, n, false);
      return;
    }
    ctx.lineWidth = 2 / this.viewScale;
    ctx.strokeStyle = '#22d3ee';
    ctx.stroke();

    // edge sliders: diamond grips at each line's midpoint
    const hr = 8 / this.viewScale;
    for (let i = 0; i < 4; i++) {
      const a = order[i];
      const b = order[(i + 1) % 4];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      ctx.beginPath();
      ctx.moveTo(mx, my - hr);
      ctx.lineTo(mx + hr, my);
      ctx.lineTo(mx, my + hr);
      ctx.lineTo(mx - hr, my);
      ctx.closePath();
      ctx.fillStyle = '#fbbf24';
      ctx.fill();
      ctx.lineWidth = 2.5 / this.viewScale;
      ctx.strokeStyle = '#92400e';
      ctx.stroke();
    }
    this.drawCornerDots(ctx, q);
    this.drawQuadNumber(ctx, order, n, true);
  }

  /** Sequence number bubble in the middle of a rectangle (crop order); 0 = none. */
  private drawQuadNumber(
    ctx: CanvasRenderingContext2D,
    order: Point[],
    n: number,
    isActive: boolean,
  ): void {
    if (!n) return;
    const cx = (order[0].x + order[1].x + order[2].x + order[3].x) / 4;
    const cy = (order[0].y + order[1].y + order[2].y + order[3].y) / 4;
    const r = 16 / this.viewScale;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = isActive ? 'rgba(8, 145, 178, 0.92)' : 'rgba(15, 23, 42, 0.65)';
    ctx.fill();
    ctx.lineWidth = 2 / this.viewScale;
    ctx.strokeStyle = isActive ? '#22d3ee' : 'rgba(34, 211, 238, 0.55)';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = `600 ${18 / this.viewScale}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), cx, cy);
  }

  private drawCornerDots(ctx: CanvasRenderingContext2D, pts: Point[]): void {
    const r = 8 / this.viewScale;
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 3 / this.viewScale;
      ctx.strokeStyle = '#0891b2';
      ctx.stroke();
    }
  }

  // --- rectification ---------------------------------------------------------

  protected async apply(): Promise<void> {
    const img = this.image;
    const quads = this.quads();
    if (!img || !quads.length || this.mode() !== 'edit') return;
    this.mode.set('processing');
    this.progress.set(0);
    await new Promise((res) => setTimeout(res)); // let the overlay paint first

    try {
      const srcCanvas = document.createElement('canvas');
      srcCanvas.width = img.width;
      srcCanvas.height = img.height;
      const sctx = srcCanvas.getContext('2d', { willReadFrequently: true })!;
      sctx.drawImage(img, 0, 0);
      const srcData = sctx.getImageData(0, 0, img.width, img.height);

      // every rectangle becomes its own rectified photo
      this.results = [];
      for (let i = 0; i < quads.length; i++) {
        const [tl, tr, br, bl] = sortCorners(quads[i]);
        const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
        // use the longest opposing edges so no side of the photo is downsampled
        const w = Math.max(1, Math.round(Math.max(dist(tl, tr), dist(bl, br))));
        const h = Math.max(1, Math.round(Math.max(dist(tl, bl), dist(tr, br))));
        const hm = computeHomography(
          [
            { x: 0, y: 0 },
            { x: w, y: 0 },
            { x: w, y: h },
            { x: 0, y: h },
          ],
          [tl, tr, br, bl],
        );
        const out = await warpPerspective(srcData, hm, w, h, (f) =>
          this.progress.set((i + f) / quads.length),
        );
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d')!.putImageData(out, 0, 0);
        this.results.push(c);
      }

      this.resultCount.set(this.results.length);
      // explicit lambda: map would pass the index as resultThumb's height
      this.resultThumbs.set(this.results.map((c) => resultThumb(c)));
      this.resultStatus.set(this.results.map(() => 'pending'));
      this.tunes = this.results.map(() => defaultTune());
      this.resultIndex.set(0);
      this.mode.set('result');
      this.showResult(0);
    } catch (e) {
      console.error(e);
      alert(`Rectification failed: ${e instanceof Error ? e.message : e}`);
      this.mode.set('edit');
    }
  }

  /** Jump to another rectified photo (strip click or arrow keys). */
  protected goToResult(i: number): void {
    if (i < 0 || i >= this.resultCount() || i === this.resultIndex()) return;
    this.resultIndex.set(i);
    this.showResult(i);
  }

  /** Blit one rectified photo into the preview and reset its metadata fields. */
  private showResult(i: number): void {
    const src = this.results[i];
    if (!src) return;
    const rc = this.resultCanvas().nativeElement;
    rc.width = src.width;
    rc.height = src.height;
    rc.getContext('2d')!.drawImage(src, 0, 0);
    // each rectified photo keeps its own tune across strip navigation
    this.editingTuneField.set(null); // drop any half-typed readout from the previous photo
    this.invalidateTuneCache();
    this.tunePreview.set(true);
    this.tune.set(this.tunes[i] ?? defaultTune());
    if (!this.tuneNeutral()) this.applyTuneNow();
    this.scheduleHistogramDraw();
    this.outSize.set({ w: src.width, h: src.height });
    this.dateField.set(''); // date starts empty; the EXIF chip can fill it on demand
    this.timeField.set(DEFAULT_TIME);
    this.descriptionField.set('');
    this.resetZoom();
    requestAnimationFrame(() => this.layoutResultCanvas());
  }

  // --- result actions --------------------------------------------------------

  protected onDateField(ev: Event): void {
    this.dateField.set((ev.target as HTMLInputElement).value);
  }

  protected onTimeField(ev: Event): void {
    this.timeField.set((ev.target as HTMLInputElement).value || DEFAULT_TIME);
  }

  protected onDescriptionField(ev: Event): void {
    this.descriptionField.set((ev.target as HTMLInputElement).value);
  }

  /**
   * Save the current rectified photo as a high-quality JPEG (q 0.95) with
   * the metadata embedded as real EXIF — DateTimeOriginal + timezone offset
   * and ImageDescription; canvas encoders emit bare JPEGs, so embedExifJpeg
   * splices the APP1 segment in — then show the next unsaved photo; the
   * image is done only when every photo is saved or closed. Hand-entered
   * metadata also lands in the scratchpad (deduped) and in the "use
   * previous" memory, so it is reusable on later photos.
   */
  protected save(): void {
    const idx = this.resultIndex();
    const suffix = this.resultCount() > 1 ? `-${idx + 1}` : '';
    const canvas = this.resultCanvas().nativeElement;
    // eye off means the UNTUNED original is on the canvas — re-bake the
    // tune first, or the export would silently drop it
    if (!this.tunePreview()) {
      this.tunePreview.set(true);
      this.applyTuneNow();
    }
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          alert('Could not encode the image.');
          return;
        }
        const userDate = this.dateField() || null;
        const description = this.descriptionField().trim() || null;
        let date = userDate;
        let time: string | null = this.timeField();
        if (!date) {
          // no date entered: silently fall back to the photo's EXIF moment
          const exif = this.exifDate();
          if (exif) {
            date = exif.iso;
            time = exif.time;
          }
        }
        void (async () => {
          let out = blob;
          // no metadata entered at all -> plain JPEG, no EXIF
          if (userDate || description) {
            const jpeg = embedExifJpeg(new Uint8Array(await blob.arrayBuffer()), {
              date,
              time,
              offset: date ? amsterdamOffset(date, time ?? DEFAULT_TIME) : null,
              description,
            });
            out = new Blob([jpeg], { type: 'image/jpeg' });
            if (
              userDate &&
              !this.scratchpad().some((e) => e.kind === 'date' && e.dateIso === userDate)
            ) {
              const [y, m, d] = userDate.split('-').map(Number);
              this.addScratchEntry('date', new Date(y, m - 1, d));
            }
            if (
              description &&
              !this.scratchpad().some((e) => e.kind === 'description' && e.text === description)
            ) {
              this.addScratchEntry('description', description);
            }
            this.lastMeta.set({
              date: this.dateField(),
              time: this.timeField(),
              description: this.descriptionField().trim(),
            });
          }
          const name = `${this.baseName}${this.filenameSuffix()}${suffix}.jpg`;
          if (this.downloadStyle() === 'zip') {
            // collect for the batch ZIP, stamped with the photo's moment; a
            // photo processed again joins under a higher number suffix
            const entry: CollectedPhoto = {
              name: this.uniqueZipName(name),
              data: new Uint8Array(await out.arrayBuffer()),
              mtime: date ? dateTimeToLocal(date, time ?? DEFAULT_TIME) : new Date(),
              thumb: resultThumb(canvas, 140),
            };
            this.zipEntries.update((list) => [...list, entry]);
          } else {
            downloadBlob(out, name);
          }
          this.finishResult(idx, 'saved');
        })();
      },
      'image/jpeg',
      this.jpegQuality(),
    );
  }

  /** First free name: the name itself, else stem-2.jpg, stem-3.jpg, … */
  private uniqueZipName(name: string): string {
    const taken = new Set(this.zipEntries().map((e) => e.name));
    if (!taken.has(name)) return name;
    const stem = name.replace(/\.jpg$/, '');
    for (let k = 2; ; k++) {
      const candidate = `${stem}-${k}.jpg`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /** Close the current preview photo without saving it. */
  protected closeResult(): void {
    this.finishResult(this.resultIndex(), 'closed');
  }

  /**
   * Download every collected photo as one ZIP whose entries carry the photo
   * dates as file dates — extraction restores them as the files' modified
   * (and on APFS: creation) time, which per-file downloads cannot.
   */
  protected downloadZip(): void {
    const entries = this.zipEntries();
    if (!entries.length) return;
    downloadBlob(
      new Blob([buildZip(entries)], { type: 'application/zip' }),
      'rectified-photos.zip',
    );
  }

  /** The split button's right half: show the collected photos. */
  protected openCollection(): void {
    const mode = this.mode();
    if (mode !== 'edit' && mode !== 'result') return;
    this.returnMode = mode;
    this.mode.set('collection');
  }

  protected backFromCollection(): void {
    this.mode.set(this.returnMode);
    requestAnimationFrame(() => {
      if (this.mode() === 'edit') this.layoutEditCanvas();
      else if (this.mode() === 'result') this.layoutResultCanvas();
    });
  }

  protected removeCollected(name: string): void {
    this.zipEntries.update((list) => list.filter((e) => e.name !== name));
  }

  protected onQuality(ev: Event): void {
    this.jpegQuality.set(+(ev.target as HTMLInputElement).value);
  }

  protected onSuffix(ev: Event): void {
    this.filenameSuffix.set(sanitizeSuffix((ev.target as HTMLInputElement).value));
  }

  /** Fill the metadata fields from the last save that carried input. */
  protected usePrevious(): void {
    const m = this.lastMeta();
    if (!m || this.mode() !== 'result') return;
    this.dateField.set(m.date);
    this.timeField.set(m.time);
    this.descriptionField.set(m.description);
  }

  /**
   * Mark one rectified photo saved/closed, then show the next pending one
   * (the last pending one when nothing follows the current photo). Only
   * when none are pending the image is done and the queue advances.
   */
  private finishResult(idx: number, status: 'saved' | 'closed'): void {
    const statuses = this.resultStatus().map((s, i) => (i === idx ? status : s));
    this.resultStatus.set(statuses);
    const after = statuses.findIndex((s, i) => i > idx && s === 'pending');
    const next = after !== -1 ? after : statuses.lastIndexOf('pending');
    if (next !== -1) {
      this.resultIndex.set(next);
      this.showResult(next);
    } else {
      this.markCurrent('saved');
      this.advance();
    }
  }

  /** Clear the whole batch and start over. */
  protected reset(): void {
    this.openToken++;
    this.image?.close();
    this.image = null;
    this.images.set([]);
    this.currentIndex.set(-1);
    // the scratchpad intentionally survives a batch reset (it is persisted);
    // it has its own clear buttons
    this.quads.set([]);
    this.draft.set([]);
    this.drafting.set(false);
    this.activeIdx.set(-1);
    this.results = [];
    this.resultCount.set(0);
    this.resultThumbs.set([]);
    this.resultStatus.set([]);
    this.tunes = [];
    this.tune.set(defaultTune());
    this.lastTune.set(null); // presets are persisted and survive on purpose
    this.invalidateTuneCache();
    this.lastMeta.set(null);
    this.zipEntries.set([]);
    this.outSize.set(null);
    this.photoDate.set(null);
    this.dateField.set('');
    this.timeField.set(DEFAULT_TIME);
    this.descriptionField.set('');
    this.setVoiceStatus(null);
    this.progress.set(0);
    this.dragIndex = -1;
    this.mode.set('idle');
  }
}

function secondsToTime(total: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.trunc(total / 3600) % 24)}:${pad(Math.trunc(total / 60) % 60)}:${pad(total % 60)}`;
}

/**
 * A canvas host's content-box size. clientWidth/Height INCLUDE the host's
 * padding, so fitting a canvas to them overflows by exactly the padding and
 * summons scrollbars at zoom 1 — subtract it. (Zoom > 1 still overflows on
 * purpose: that is what panning scrolls.)
 */
function hostContentSize(host: HTMLElement): { w: number; h: number } {
  const cs = getComputedStyle(host);
  return {
    w: host.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    h: host.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
  };
}

function toIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** An ISO date (YYYY-MM-DD) shifted by whole days; month/year roll over. */
function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return toIsoDate(new Date(y, m - 1, d + days));
}

/** Keep a filename suffix safe: no path separators or forbidden characters. */
function sanitizeSuffix(raw: string): string {
  return raw.replace(/[/\\:*?"<>|]/g, '').slice(0, 40);
}

/** Clamp a number to [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Strip characters a tune readout input can't hold: digits everywhere, a
 * leading minus for the signed fields (brightness/contrast), and a single
 * decimal point for gamma. Letters and `e` are rejected — the point of the
 * click-to-edit is a strictly numeric field.
 */
function filterTuneNumInput(v: string, field: TuneNumField): string {
  if (field === 'gamma') {
    const cleaned = v.replace(/[^0-9.]/g, '');
    const dot = cleaned.indexOf('.');
    // keep only the first dot
    return dot < 0 ? cleaned : cleaned.slice(0, dot + 1) + cleaned.slice(dot + 1).replace(/\./g, '');
  }
  const digits = v.replace(/[^0-9]/g, '');
  // brightness/contrast are signed; keep a single leading minus
  return (field === 'brightness' || field === 'contrast') && v.trimStart().startsWith('-')
    ? '-' + digits
    : digits;
}

/** Loose shape check for tune presets loaded from localStorage. */
function isValidTunePreset(p: TunePreset): boolean {
  const lv = (l: ChannelLevels | undefined) =>
    !!l &&
    typeof l.black === 'number' &&
    typeof l.gamma === 'number' &&
    typeof l.white === 'number';
  return (
    !!p &&
    typeof p.id === 'number' &&
    typeof p.name === 'string' &&
    !!p.tune &&
    typeof p.tune.brightness === 'number' &&
    typeof p.tune.contrast === 'number' &&
    !!p.tune.levels &&
    lv(p.tune.levels.rgb) &&
    lv(p.tune.levels.r) &&
    lv(p.tune.levels.g) &&
    lv(p.tune.levels.b)
  );
}

/** ISO date + HH:MM[:SS] as a local-time Date. */
function dateTimeToLocal(iso: string, time: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  const [hh = 12, mi = 0, ss = 0] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mi, ss);
}

/** Downscale a rectified photo to a small dataURL (JPEG keeps it small). */
function resultThumb(src: HTMLCanvasElement, h = 64): string {
  const w = Math.max(1, Math.round((src.width / src.height) * h));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(src, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.8);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
