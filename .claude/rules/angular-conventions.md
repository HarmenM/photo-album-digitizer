# Angular conventions

- Angular 22, standalone bootstrap (`bootstrapApplication` in `main.ts`), and
  **zoneless** change detection (no `zone.js` dependency). UI updates must flow
  through signals — mutating plain fields will not re-render.
- State is signal-based: `signal()` for state, `computed()` for derivations,
  `viewChild.required<ElementRef<...>>()` for DOM refs. Members used by the
  template are `protected readonly`; internals are `private`.
- Templates and styles are separate files (`templateUrl`/`styleUrl`), template
  syntax uses the modern control flow (`@if`, `@for`) and event/property
  bindings — no `*ngIf`/`*ngFor`.
- Types live next to their use: small `interface`/`type` declarations at the
  top of `app.ts` (e.g. `QueueItem`, `ScratchEntry`), shared geometry types in
  `homography.ts` (`Point`).
- Formatting is Prettier (`.prettierrc`: 100-col, single quotes, Angular parser
  for HTML). Match it; don't hand-format differently.
- Comments explain *why* (coordinate conventions, browser quirks, tuning
  rationale), not what the next line does. Keep that density — this codebase
  relies on them for the non-obvious math.
- Commands: `npm start` (ng serve, port 4200), `npm run build`, `npm test`.
