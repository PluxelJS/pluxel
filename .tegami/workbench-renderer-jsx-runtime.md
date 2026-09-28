---
packages:
  '@pluxel/rolldown': patch
---

# Match renderer JSX to the shared Shell runtime

Use production-compatible JSX calls even for development renderers, so a packaged Shell can render them without jsxDEV. Invalidate cached renderer revisions.
