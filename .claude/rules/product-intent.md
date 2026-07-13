# Product intent — the main guideline

**This is the primary rule for this project. Every feature, fix, and refactor
must serve this workflow; when another rule or an implementation detail
conflicts with it, this intent wins.**

The app digitizes old photos that have been photographed (e.g. pages from a
photobook shot with a camera or phone).

## Core workflow

1. **Add photos** to the app (multi-image queue with a thumbnail drawer; images
   are added via file picker or drag-and-drop).
2. **Mark boundaries**: when a photo is active, place/adjust the boundary
   corners around each picture — an album page may hold several pictures,
   each getting its own rectangle.
3. Then choose one of two paths:

### Path 1 — Image preview

- Shows the rectified pictures one at a time, warped from the
  boundaries/corners provided.
- Add metadata per picture: **date** and **description**.
- Scratchpad entries can be used to quick-fill the metadata (clickable chips).
- Download/save each picture with its metadata.

### Path 2 — Info scratchpad

- For photos you don't want to save (yet) but that contain useful data:
  captions, descriptions, dates.
- Collect that data into the shared scratchpad — an **always-visible side
  panel** (no separate page or mode) — then move on to the next photo.
- The scratchpad feeds Path 1's quick-fill on later photos.

## What this means when working on the project

- The two paths (preview+save vs. collect-info) are the backbone of the UX;
  keep both first-class and keep switching between photos fast.
- The scratchpad is the bridge between the paths — data collected from info
  pages must remain effortlessly reusable when saving other photos. Keeping
  the panel permanently on screen is deliberate: collecting must never
  require leaving the current photo.
- Optimize for batch throughput: a user works through a whole queue of photos
  in one sitting, so minimize clicks and keystrokes per photo.
