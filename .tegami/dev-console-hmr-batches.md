---
packages:
  '@pluxel/host-vite':
    type: minor
  '@pluxel/cli':
    type: minor
  '@pluxel/create':
    type: patch
---

## Control HMR batches from the development console

Add `pluxel dev hmr pause`, `apply`, and `resume` with instance selection, receipts,
result recovery, and cancellation. HMR controls remain available when application
source is broken and across full Host replacement. `dev status` reports the current
mode and pending work alongside the existing application update report.

Coalesce observed changes into one bounded pending batch while a single batch runs.
Paused sessions keep observing edits without evaluating each intermediate state;
apply processes one batch and remains paused. Failed work stays available for a
subsequent explicit retry or new observation without a retry loop. Console scripts
reject pending runtime changes instead of implicitly applying incomplete edits.

Update the development guide, skill, and generated project instructions with the
pause → edit and check → apply → verify workflow. Resume only after successful
verification when the instance originally used automatic updates.
