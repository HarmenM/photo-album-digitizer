import {
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  signal,
  viewChild,
} from '@angular/core';
import { detectPageCorners, detectPhotoRects, snapCornersToEdges } from './corner-detect';
import { parseSpokenDate, readExifDate } from './exif';
import { Point, computeHomography, insetQuad, sortCorners, warpPerspective } from './homography';
import { buildXmpSidecar } from './xmp';

type Mode = 'idle' | 'edit' | 'processing' | 'result' | 'done';
type ImageStatus = 'pending' | 'saved';

interface QueueItem {
  id: number;
  file: File;
  name: string;
  thumb: string; // small dataURL, '' while still generating
  status: ImageStatus;
  rotation: number; // clockwise quarter turns applied in the editor: 0/90/180/270
  quads?: Point[][]; // last photo rectangles; undefined = never visited (auto-detect)
}

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
interface Recognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
}

const HIT_RADIUS_CSS_PX = 16;
const SCRATCH_STORAGE_KEY = 'photo-rectifier.scratchpad';
const DEFAULT_TIME = '12:00:00';
// Repeated D presses / Detect clicks re-run detection at climbing threshold
// levels for pages whose light photo content gets trimmed at the default;
// the cycle resets to the first level after a pause or on a photo switch.
const DETECT_LEVELS = [0.6, 0.7, 0.8, 0.9];
const DETECT_LEVEL_RESET_MS = 2000;

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
  protected readonly voiceStatus = signal<string | null>(null);
  protected readonly zoom = signal(1);
  protected readonly loupeVisible = signal(false);

  protected readonly hint = computed(() => {
    if (this.drafting()) {
      return `Click the corners of a photo — ${4 - this.draft().length} to go (Esc cancels)`;
    }
    const n = this.quads().length;
    if (n === 0) return 'No photos marked — detect (D) or add a photo';
    return `${n} photo${n > 1 ? 's' : ''} selected`;
  });

  private readonly editCanvas = viewChild.required<ElementRef<HTMLCanvasElement>>('editCanvas');
  private readonly canvasHost = viewChild.required<ElementRef<HTMLDivElement>>('canvasHost');
  private readonly resultCanvas = viewChild.required<ElementRef<HTMLCanvasElement>>('resultCanvas');
  private readonly resultHost = viewChild.required<ElementRef<HTMLDivElement>>('resultHost');
  private readonly loupeCanvas = viewChild.required<ElementRef<HTMLCanvasElement>>('loupeCanvas');

  private image: ImageBitmap | null = null;
  private baseName = 'photo';
  private detectLevelIdx = 0; // position in the DETECT_LEVELS cycle
  private detectLevelTimer: ReturnType<typeof setTimeout> | null = null;
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
      const raw = localStorage.getItem(SCRATCH_STORAGE_KEY);
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
    if (this.mode() === 'idle' || this.mode() === 'done') void this.openImage(firstNew);
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
    // new photo: the D-shortcut threshold cycle starts over
    if (this.detectLevelTimer) clearTimeout(this.detectLevelTimer);
    this.detectLevelIdx = 0;
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
   * single page outline when none are found). On the first visit of an image
   * (manual = false) every detected rectangle is refined further: snap the
   * corners to the full-res contrast boundary, then step 5 px inward so the
   * default crop carries no background sliver. The D shortcut / toolbar
   * button runs the plain detection only, and repeated presses climb the
   * DETECT_LEVELS threshold cycle (reset by a 2 s pause or a photo switch).
   */
  protected autoDetect(manual = true): void {
    const img = this.image;
    if (!img || this.mode() !== 'edit') return;
    let level = DETECT_LEVELS[0];
    if (manual) {
      level = DETECT_LEVELS[this.detectLevelIdx];
      this.detectLevelIdx = (this.detectLevelIdx + 1) % DETECT_LEVELS.length;
      if (this.detectLevelTimer) clearTimeout(this.detectLevelTimer);
      this.detectLevelTimer = setTimeout(() => (this.detectLevelIdx = 0), DETECT_LEVEL_RESET_MS);
    }
    let found = detectPhotoRects(img, level);
    if (!found.length) {
      const page = detectPageCorners(img);
      if (page) found = [page];
    }
    if (found.length) {
      this.draft.set([]);
      this.drafting.set(false);
      if (!manual) {
        found = found.map((q) => {
          const snapped = snapCornersToEdges(img, q).map((p) => this.clampToImage(p));
          const inset = insetQuad(sortCorners(snapped), 5);
          return inset ? inset.map((p) => this.clampToImage(p)) : snapped;
        });
      }
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
    if (!rc.width || !rc.height || !host.clientWidth || !host.clientHeight) return;
    const fit = Math.min(host.clientWidth / rc.width, host.clientHeight / rc.height, 1);
    const z = fit * this.zoom();
    rc.style.width = `${rc.width * z}px`;
    rc.style.height = `${rc.height * z}px`;
  }

  /**
   * Snap each corner of the active rectangle onto the photo's contrast
   * boundary, searching a 50 px box around it. Runs automatically on every
   * newly completed rectangle (auto-detect, fourth click) but never after a
   * manual drag — the loupe exists for deliberate placement, and snapping
   * would fight it.
   */
  protected correctBoundaries(): void {
    const img = this.image;
    const a = this.activeIdx();
    if (!img || this.mode() !== 'edit' || a < 0) return;
    const snapped = snapCornersToEdges(img, this.quads()[a]).map((p) => this.clampToImage(p));
    this.quads.update((qs) => qs.map((q, i) => (i === a ? snapped : q)));
    this.redraw();
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

  private recognize(onDone: (alternatives: string[]) => void): void {
    const w = window as unknown as Record<string, new () => Recognition>;
    const RecognitionCtor = w['SpeechRecognition'] ?? w['webkitSpeechRecognition'];
    if (!RecognitionCtor) {
      alert('Speech recognition is not supported in this browser.');
      return;
    }
    if (this.listening()) return;
    const rec = new RecognitionCtor();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 3;
    this.listening.set(true);
    rec.onresult = (ev) => onDone(Array.from(ev.results[0]).map((a) => a.transcript));
    rec.onerror = (ev) => this.setVoiceStatus(`Speech recognition error: ${ev.error}`);
    rec.onend = () => this.listening.set(false);
    rec.start();
  }

  /** Dictate a description, into the current field or the scratchpad. */
  protected dictate(target: 'field' | 'scratchpad'): void {
    this.setVoiceStatus('Listening — say a description', 0);
    this.recognize((alternatives) => {
      const heard = alternatives[0]?.trim() ?? '';
      if (!heard) {
        this.setVoiceStatus('Heard nothing — try again');
        return;
      }
      if (target === 'field') this.descriptionField.set(heard);
      else this.addScratchEntry('description', heard);
      this.setVoiceStatus(`Heard “${heard}” — description ${target === 'field' ? 'set' : 'noted'}`);
    });
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
  }

  /**
   * Use a scratchpad entry as the current date or description. Every use of a
   * date advances its time by one second (12:00:00, 12:00:01, …) so photos
   * sharing a date keep a stable chronological order. Only meaningful on the
   * result screen — the panel is always visible, but the metadata fields are
   * not, so a chip click elsewhere does nothing.
   */
  protected applyScratch(entry: ScratchEntry): void {
    if (this.mode() !== 'result') return;
    if (entry.kind === 'date' && entry.dateIso) {
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

  protected backToEdit(): void {
    this.results = []; // discard pending rectified photos
    this.resultCount.set(0);
    this.resultThumbs.set([]);
    this.resetZoom();
    this.mode.set('edit');
    requestAnimationFrame(() => this.layoutEditCanvas());
  }

  // --- rotation --------------------------------------------------------------

  /** Platform-aware label for the confirm shortcut, used in tooltips. */
  protected readonly confirmKey = /mac/i.test(navigator.userAgent) ? '⌘+Enter' : 'Alt+Enter';

  @HostListener('window:keydown', ['$event'])
  protected onKeyDown(ev: KeyboardEvent): void {
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

    // Escape returns from the result screen to the corner editor
    if (ev.key === 'Escape' && this.mode() === 'result') {
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
    else if (key === 'd' && this.mode() === 'edit') this.autoDetect();
    else if (key === 's' && this.mode() === 'edit') this.shrinkQuad();
    else if (key === 'c' && this.mode() === 'edit') this.correctBoundaries();
    else if ((ev.key === 'Delete' || ev.key === 'Backspace') && this.mode() === 'edit') {
      this.deleteActive();
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

  protected clearCorners(): void {
    this.quads.set([]);
    this.draft.set([]);
    this.drafting.set(false);
    this.activeIdx.set(-1);
    this.redraw();
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
    const cw = host.clientWidth;
    const ch = host.clientHeight;
    if (!cw || !ch) return;
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
      this.resultThumbs.set(this.results.map(resultThumb));
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
   * Save the current rectified PNG plus an XMP sidecar, then show the next
   * rectangle's photo, or move to the next image after the last one.
   */
  protected save(): void {
    const idx = this.resultIndex();
    const suffix = this.resultCount() > 1 ? `-${idx + 1}` : '';
    this.resultCanvas().nativeElement.toBlob((blob) => {
      if (!blob) {
        alert('Could not encode the image.');
        return;
      }
      downloadBlob(blob, `${this.baseName}-rectified${suffix}.png`);
      const userDate = this.dateField() || null;
      const description = this.descriptionField().trim() || null;
      // no metadata entered at all -> no sidecar
      if (userDate || description) {
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
        const xmp = buildXmpSidecar({ date, time, description });
        downloadBlob(
          new Blob([xmp], { type: 'application/rdf+xml' }),
          `${this.baseName}-rectified${suffix}.xmp`,
        );
      }
      if (idx + 1 < this.resultCount()) {
        this.resultIndex.set(idx + 1);
        this.showResult(idx + 1);
      } else {
        this.markCurrent('saved');
        this.advance();
      }
    }, 'image/png');
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

function toIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Downscale a rectified photo to a strip-sized dataURL (JPEG keeps it small). */
function resultThumb(src: HTMLCanvasElement): string {
  const h = 64;
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
