# UI interactions & shortcuts — don't break these

Keyboard shortcuts (all surfaced in button tooltips — update the tooltip when
you change a binding):

- `R` / `L` rotate, `D` re-detect photos, `S` shrink active rectangle 10 px,
  `C` correct boundaries of the active rectangle (snap corners to contrast
  edges), `Delete`/`Backspace` delete the draft corners or else the active
  rectangle, `I` mark as info page.
- `←` / `→` previous/next photo (edit mode).
- `Alt/⌘ + Enter` confirms the current phase (Apply / Save & next / Info done)
  and must keep working **while an input is focused**.
- `Esc` returns from result/info to the corner editor; inside an input the
  first `Esc` blurs, the second exits.
- `Ctrl/⌘ +/−/0` zooms previews; pinch arrives as ctrl+wheel; plain scroll pans.

Interaction invariants:

- Multiple photo rectangles per image; exactly one is active. The active one
  shows corner dots and amber ◆ midpoint grips (drag a corner / slide a whole
  edge along its normal); inactive ones render dashed and are activated by
  clicking inside them. Dragging empty canvas pans; a plain click adds a
  draft corner (four clicks complete a new rectangle, which snaps and becomes
  active).
- Each rectangle shows its crop-order number in a bubble at its centroid,
  matching the "photo i / n" counter in the preview step — but only when
  there are two or more rectangles (a lone rectangle carries no number).
- While dragging a corner, the circular precision loupe follows the pointer:
  full-res magnified image, cyan outer crosshair, red-on-white center cross at
  the exact corner position, flipping below the pointer near the top edge.
- `overscroll-behavior: none` is set everywhere on purpose — trackpad panning
  must never trigger browser history-back. Don't remove it.
- Thumbnails refresh on rotate and each has an × remove button; saved/info
  status counts show in the drawer, plus a bottom-left count badge with the
  number of photo rectangles on that image.
