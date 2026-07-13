# UI interactions & shortcuts — don't break these

Keyboard shortcuts (all surfaced in button tooltips — update the tooltip when
you change a binding):

- `R` / `L` rotate, `D` re-detect corners, `S` shrink quad 10 px, `C` correct
  boundaries (snap corners to contrast edges), `I` mark as info page.
- `←` / `→` previous/next photo (edit mode).
- `Alt/⌘ + Enter` confirms the current phase (Apply / Save & next / Info done)
  and must keep working **while an input is focused**.
- `Esc` returns from result/info to the corner editor; inside an input the
  first `Esc` blurs, the second exits.
- `Ctrl/⌘ +/−/0` zooms previews; pinch arrives as ctrl+wheel; plain scroll pans.

Interaction invariants:

- Corner dots drag individual corners; amber ◆ midpoint grips slide a whole
  edge along its normal; dragging empty canvas pans.
- While dragging a corner, the circular precision loupe follows the pointer:
  full-res magnified image, cyan outer crosshair, red-on-white center cross at
  the exact corner position, flipping below the pointer near the top edge.
- `overscroll-behavior: none` is set everywhere on purpose — trackpad panning
  must never trigger browser history-back. Don't remove it.
- Thumbnails refresh on rotate and each has an × remove button; saved/info
  status counts show in the drawer.
