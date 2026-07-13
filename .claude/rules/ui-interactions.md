# UI interactions & shortcuts — don't break these

Keyboard shortcuts (all surfaced in button tooltips — update the tooltip when
you change a binding):

- `R` / `L` rotate, `D` re-detect photos (repeated presses retry at climbing
  threshold levels 0.6 → 0.7 → 0.8 → 0.9; the cycle resets after 2 s without
  a press or on a photo switch), `S` shrink active rectangle 10 px,
  `C` correct boundaries of the active rectangle (snap corners to contrast
  edges), `Delete`/`Backspace` cancel an in-progress rectangle or else delete
  the active rectangle.
- `←` / `→` previous/next photo (edit mode); on the result screen they step
  through the rectified photos instead.
- `Alt/⌘ + Enter` confirms the current phase (Apply / Save & next)
  and must keep working **while an input is focused**.
- `Esc` cancels an in-progress rectangle in the editor, and returns from
  the result screen to the corner editor; inside an input the first `Esc`
  blurs, the second exits.
- `Ctrl/⌘ +/−/0` zooms previews; pinch arrives as ctrl+wheel; plain scroll pans.

Interaction invariants:

- Multiple photo rectangles per image; exactly one is active. The active one
  shows corner dots and amber ◆ midpoint grips (drag a corner / slide a whole
  edge along its normal); inactive ones render dashed and are activated by
  clicking inside them. Dragging empty canvas pans; a plain click does
  nothing on its own.
- New rectangles are drawn deliberately, never by stray clicks: the "Add
  photo" toolbar button enters drafting mode (button renders active),
  then four plain clicks place the corners — the fourth completes the
  rectangle, which snaps and becomes active, and drafting ends. While
  drafting, only the draft's own corners are draggable (edge grips and
  rectangle activation are suspended so they can't swallow corner clicks).
  Cancel by pressing the button again, `Esc`, or `Delete`.
- Each rectangle shows its crop-order number in a bubble at its centroid,
  matching the "photo i / n" counter in the preview step — but only when
  there are two or more rectangles (a lone rectangle carries no number).
- The result screen has a bottom strip with one numbered thumbnail per
  rectified photo (click or `←`/`→` to jump); like the centroid bubbles it
  only appears when there are two or more. Rotating a result persists into
  its stored canvas, so the strip thumb and a later revisit stay in sync.
- While dragging a corner, the circular precision loupe follows the pointer:
  full-res magnified image, cyan outer crosshair, red-on-white center cross at
  the exact corner position, flipping below the pointer near the top edge.
- `overscroll-behavior: none` is set everywhere on purpose — trackpad panning
  must never trigger browser history-back. Don't remove it.
- Thumbnails refresh on rotate and each has an × remove button, a ✓ badge
  when saved, and a bottom-left count badge with the number of photo
  rectangles on that image.
- The scratchpad is an always-visible right side panel on the editor and
  result screens (no separate page or mode). Entries can be added anytime
  (typed or dictated); on the result screen the chips become clickable and
  fill the metadata fields. It can be collapsed to a slim vertical rail
  (label + entry count, one click re-expands) but never disappears from the
  screen. Don't move it back behind a mode switch.
