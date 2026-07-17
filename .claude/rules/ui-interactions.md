# UI interactions & shortcuts — don't break these

## Mobile layout (single-image workflow)

Below 720 px viewport width — or on a coarse-pointer (touch) device whose
viewport is at most 500 px tall, which catches large phones in landscape
while every tablet stays desktop (`MOBILE_QUERY` in `app.ts`) — the app
switches to a mobile layout. One `matchMedia` query drives both the template
switches (the `isMobile` signal) and the CSS (a `.mobile` class bound on the
host) — never introduce a second breakpoint source. On mobile:

- **Single image**: the drawer is not rendered, the file picker is
  single-select (`[attr.multiple]`), and the whole ZIP flow is hidden AND
  disabled — template zip checks and `save()` go through
  `effectiveDownloadStyle` (forced `'single'` on mobile) while the persisted
  `downloadStyle` setting survives untouched for the desktop; the settings
  modal hides the download-style radios.
- **The scratchpad panel is not rendered** — this is the one sanctioned
  exception to the "always-visible side panel" invariant below (the desktop
  rule stands).
- **The tune section moves into the "Image adjustments" modal**, opened by
  the result toolbar's `tune` icon button (mobile-only). The markup lives
  once in the `#tunePanelTpl` ng-template, rendered EITHER in the side panel
  (desktop) or in the modal (mobile) — never both, so the `histCanvas` /
  `tuneNumInput` viewChild refs stay unambiguous. Esc closes it (after the
  preset modal, which can sit on top).
- **Toolbar and meta-bar buttons are icon-only**: every label is wrapped in
  a `.label` span that mobile CSS hides — keep new button labels in that
  span, and keep the `title` tooltips carrying the full text.
- **A bottom action bar (`.mobile-bar`, mobile-only) carries the phase
  confirm and the way back**, for thumb reach: on the editor **Start over**
  (= `closeImage()` — the single-image "drop this and pick another") +
  **Apply**; on the result screen **Back to corners** + **Save & next**.
  Its buttons keep their text labels (the icon-only rule above is for the
  top bars). The duplicated top-toolbar buttons — Apply, Close image,
  Back to corners, Save & next — are template-hidden on mobile
  (`@if (!isMobile())`), and the edit toolbar's **Reset** is hidden on
  mobile too (too destructive for a stray tap; detection still runs on
  first visit). Keep bar and top-bar hiding in sync: a confirm action must
  exist exactly once on mobile.
- **Meta bar on mobile**: "Use previous" is not rendered (the single-image
  flow has no batch of earlier saves worth refilling from), and the mic
  button sits beside the description field on the same row (the
  description's `flex-basis` deliberately leaves room for it — don't bump
  it back to 100%).
- **"Take a photo" on the drop screen (mobile-only)**: a second hidden file
  input (`#cameraInput`, `capture="environment"`) opens the rear camera
  directly and feeds the same `onFileInput` intake. It is deliberately a
  separate input + button — putting `capture` on the main picker would
  steal the gallery path on phones. Tapping the rest of the dropzone still
  opens the regular picker.

All mobile CSS is scoped under `:host(.mobile)` in `app.css`; the desktop
layout must stay pixel-identical.

Keyboard shortcuts (all surfaced in button tooltips — update the tooltip when
you change a binding):

- `R` / `L` rotate, `S` shrink active rectangle 10 px,
  `C` correct boundaries of the active rectangle (snap corners to contrast
  edges; progressive — a repeat press within 2 s widens the search: L, XL,
  shown as a badge on the button and reset by 2 s of inactivity, Reset, or
  an image switch). Each snap flashes dashed amber circles around the
  pre-snap corners for 1 s showing the searched area (experimental; the
  `snapFlash` field, its timer and the redraw block are the whole feature —
  delete those to revert). `Delete`/`Backspace` cancel an in-progress
  rectangle or else delete the active rectangle. There is deliberately no detect shortcut/button:
  detection runs on first visit and via the toolbar's **Reset** (remove all
  rectangles + detect afresh, same snap + 5 px shrink flow).
- `←` / `→` previous/next photo (edit mode); on the result screen they step
  through the rectified photos instead.
- Result screen, tune panel: `B` toggles the before/after eye (a no-op on
  a neutral tune, matching the button's disabled state), `U` applies the
  last configured tune, and `Ctrl/⌘ + 1`…`5` applies the first five
  presets — those digits work while an input is focused (like the confirm
  shortcut) and each chip shows its number so the shortcut is
  discoverable. Save preset deliberately has no shortcut.
- `Alt/⌘ + Enter` confirms the current phase (Apply / Save & next)
  and must keep working **while an input is focused**.
- `Esc` cancels an in-progress rectangle in the editor, and returns from
  the result screen to the corner editor; inside an input the first `Esc`
  blurs, the second exits. On the result screen `Backspace` and the browser
  **Back** button behave like `Esc` (Backspace still deletes text while an
  input is focused — the input guard runs first). Back works via a history
  entry pushed on entering the result (popstate → `backToEdit`), consumed
  again by every other exit — keep push and pop paired or Back starts
  leaving the app / reopening stale screens.
- `Ctrl/⌘ +/−/0` zooms previews; pinch arrives as ctrl+wheel; plain scroll pans.

Interaction invariants:

- Icons are Google **Material Symbols** (self-hosted font, see styles.css),
  never emojis — emojis in labels/buttons have been deliberately replaced
  app-wide. Plain typographic glyphs (×, ✓ badges, ‹ › chevrons, ←/→ in
  tooltip texts) are fine.

- Edit-toolbar layout (groups separated by vertical dividers): rotate
  left/right (icon-only) | Mark another photo · Correct boundaries | Shrink
  border · Delete | Reset (drop all rectangles + auto-detect afresh) ·
  Close image (drop the whole image from the batch, same as the drawer
  thumb's ×) | Apply | ZIP split button (zip download style only) |
  settings cogwheel (icon-only). The result toolbar's rotate buttons are
  icon-only too, it carries the same Close image button (after Close
  photo — Close photo skips one rectified photo, Close image discards the
  source image with all its photos), and it ends with the same ZIP split
  button + cogwheel.
- Settings live in a modal behind the cogwheel (Esc or backdrop click
  closes): JPG quality slider and the download style radios. The ZIP split
  button's main half downloads the archive, the right segment opens the
  collection page — a screen listing every collected photo with a × to
  remove it (Esc or Back returns to where you came from; the page is only
  reachable in zip mode).

- Multiple photo rectangles per image; exactly one is active. The active one
  shows corner dots and amber ◆ midpoint grips (drag a corner / slide a whole
  edge along its normal); inactive ones render dashed and are activated by
  clicking inside them. Dragging empty canvas pans; a plain click does
  nothing on its own.
- New rectangles are drawn deliberately, never by stray clicks: the "Mark
  another photo" toolbar button enters drafting mode (button renders
  active), then four plain clicks place the corners — the fourth completes
  the rectangle, which snaps and becomes active, and drafting ends. While
  drafting, only the draft's own corners are draggable (edge grips and
  rectangle activation are suspended so they can't swallow corner clicks).
  Cancel by pressing the button again, `Esc`, or `Delete`.
- Each rectangle shows its crop-order number in a bubble at its centroid,
  matching the "photo i / n" counter in the preview step — but only when
  there are two or more rectangles (a lone rectangle carries no number).
  Rotating the image renumbers: the quads are re-sorted into the new
  orientation's reading order (top-left first, bottom-right last, via
  `readingOrder` in `corner-detect.ts`), so the numbers never stay glued to
  the pre-rotation order; the active rectangle stays active across the
  reorder.
- The result screen has a bottom strip with one numbered thumbnail per
  rectified photo (click or `←`/`→` to jump); like the centroid bubbles it
  only appears when there are two or more. Rotating a result persists into
  its stored canvas, so the strip thumb and a later revisit stay in sync.
- Each rectified photo is saved ("Save & next") or closed unsaved ("Close
  photo") individually: saved thumbs get a green ✓ badge (same style as the
  drawer), closed ones render dimmed. Save/close shows the next pending
  photo — the last pending one when nothing follows — and only when none
  are pending does the queue advance to the next image. Don't restore the
  old advance-on-last-save: it silently dropped unsaved photos.
- "Use previous" in the metadata bar refills date, time and description
  from the last save that carried input; hand-entered metadata also becomes
  scratchpad chips on save (deduped). Date chips carry a "+1d" mini-button
  (left of the ×) that applies the chip's date shifted one day forward.
- While dragging a corner, the circular precision loupe follows the pointer:
  full-res magnified image, cyan outer crosshair, red-on-white center cross at
  the exact corner position, flipping below the pointer near the top edge.
- `overscroll-behavior: none` is set everywhere on purpose — trackpad panning
  must never trigger browser history-back. Don't remove it.
- Thumbnails refresh on rotate and each has an × remove button, a ✓ badge
  when saved, and a bottom-left count badge with the number of photo
  rectangles on that image. Drawer thumbs never flex-shrink — a full drawer
  scrolls instead of squashing them. Every image switch (arrow keys, drawer
  click, save-advance, Close image, newly dropped files) scrolls the new
  image's thumb into view (`scrollThumbIntoView` in `openImage`) so the
  drawer always follows the queue.
- Dropping (or picking) new files opens the first newly added image right
  away, from any screen except mid-warp (`processing`) — current rectangles
  are stashed per queue item, so nothing is lost by the jump.
- The side panel gains a **Color correction** section (internally still "the
  tune": `tune.ts`, `.tune-*` classes) on the result screen only,
  below the scratchpad entries and pinned to the panel's bottom edge
  (levels with channel selector RGB/R/G/B + input histogram, then — behind a
  divider line marking them as a separate adjustment — brightness and
  contrast — see image-pipeline.md): per rectified photo, kept while
  stepping through the strip, baked into the save. Channel buttons carry a
  small amber dot when that channel's levels are non-neutral; ↺ Reset
  restores the current photo to neutral. Each slider's numeric readout (the
  cyan `<b>`) is **click-to-edit**: clicking swaps it for an inline input to
  type an exact value — digits only, plus a leading minus for
  brightness/contrast and a single dot for gamma (`filterTuneNumInput`
  strips the rest, so letters/`e` never land). The value applies **live
  while typing, debounced 200 ms** (clamped to the slider's range,
  black/white still fenced off each other); Enter or blur commits and
  closes. Esc — or leaving the field blank — reverts to the pre-edit tune
  (a snapshot taken when editing began undoes the live changes) without
  leaving the result screen. The input has no `[value]` binding on purpose:
  its text is seeded imperatively in `startEditTuneField`, so a live re-apply
  can't rewrite the caret away. The readout rows are `<div>`, not `<label>`
  — a label would forward a click on the number to the range slider — and
  the `<b>` carries a transparent border matching the input's box so
  opening the editor causes no layout shift. The icon-only eye toggle (Material
  `visibility`/`visibility_off`, left of Reset) is the before/after
  comparison, Photoshop-preview style: eye on (default) = tuned photo, eye
  off = untuned original (icon slashed, tinted amber). Moving a slider or
  switching photos turns the eye back on, and `save()` re-bakes the tune
  first when the eye is off (the canvas is what gets exported; without
  that the save would silently drop the tune). Below the sliders:
  **Use last settings** (applies the last non-neutral tune configured on
  any photo; in-memory like the metadata bar's "use previous", cleared on
  batch reset) and **Save preset** (small modal asks a name; saving under
  an existing name overwrites it). Presets persist in localStorage
  (`photo-album-digitizer.tune-presets`) and render as clickable chips
  with a star toggle and a × remove button. The star (outlined `star`, filled
  amber when on) marks a preset as the **default tune** for every rectified
  photo (`defaultPresetId`, persisted in the settings JSON): clicking it makes
  that preset the default and stamps it onto all currently loaded results at
  once (and every future Apply seeds new photos from it via
  `defaultTuneForNewPhoto`); a second click — or starring another preset —
  clears it. Removing the default preset (or a stale id at load) resets it to
  none. Collapsing the panel hides the section along with the scratchpad — it
  must never move to a separate page or modal.
- The scratchpad is an always-visible right side panel on the editor and
  result screens (no separate page or mode). Entries can be added anytime
  (typed or dictated); on the result screen the chips become clickable and
  fill the metadata fields. It can be collapsed to a slim vertical rail
  (label + entry count, one click re-expands) but never disappears from the
  screen. Don't move it back behind a mode switch. (Sole exception: the
  mobile single-image layout drops the panel entirely — see the mobile
  section at the top.)
