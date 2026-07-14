# Testing & verification

- The repo has **no committed E2E tests**. Verification so far has been done
  with throwaway Playwright scripts living in the Claude session scratchpad
  (they drive `ng serve --port 4299` with synthetic JPEGs: a known quad with
  colored corner markers, a noisy "realistic" page, a hand-crafted EXIF APP1
  segment, and a stubbed `SpeechRecognition`). If lasting tests are wanted,
  copy them into the project — scratchpad scripts vanish with the session.
- When writing E2E checks: change detection is zoneless and rendering is async,
  so wait ~200 ms after a click before reading input values or canvas state.
- Prefer verifying visually/behaviorally: many features are canvas drawing
  (corner dots, midpoint grips, loupe) that unit tests can't see. Screenshots
  from a driven browser are the reliable signal.
- The pure modules (`corner-detect.ts`, `homography.ts`, `exif.ts`, `xmp.ts`,
  `zip.ts`) are the right place for unit tests — they need no DOM.
- Manual smoke test: `npm start`, drop a photo, check auto-detected corners,
  drag one (loupe should appear, crosshair centered), Apply, fill date, Save.
