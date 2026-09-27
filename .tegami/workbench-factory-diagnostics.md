---
packages:
  '@pluxel/workbench': patch
---

## Correlate Workbench factory failures

Workbench open failures now distinguish invalid and reused targets from arbitrary factory exceptions. Factory failures expose a diagnostic id linked to the server log, without sending exception details to the browser.
