---
packages:
  '@pluxel/workbench': patch
---

## Align Workbench control sizes and radii

The shared Mantine theme now uses one 4px-grid height scale for buttons, inputs
and icon buttons (24 / 28 / 32 px for `xs` / `sm` / `md`), so controls placed side
by side line up. `ActionIcon` defaults to `sm`, segmented controls are 28px tall,
small badges share a 20px height, and badges and modals use the same two radii as
the rest of the Workbench: 6px for controls and 8px for surfaces.
