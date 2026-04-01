# Components Design Policy

This file is the product-level design contract for `packages/components`.
Future LLM edits in this package should follow this document before changing frontend visuals.

## Core Policy

We standardize on Mantine for component design.

That means:

- Mantine decides component structure and baseline appearance.
- We maintain one external color system.
- That color system may influence Mantine colors and our own layout surfaces.
- Our own custom styling must be limited to layout, shell structure, and a small set of neutral shared surfaces.

It does not mean:

- creating a second component design system in SCSS
- globally repainting Mantine buttons, inputs, tabs, cards, or forms
- adding ad hoc global classes for one feature page

## Allowed Styling Layers

1. Accent source
   The editable product accent presets under `src/theme/accent/`.

2. Semantic color model
   The `src/theme/core/` layer that converts accent plus light/dark mode into `--plx-*` variables.

3. Mantine adapter
   The `src/theme/mantine/` layer that feeds those colors into Mantine.

4. Layout styling
   Workbench shell, plugin workbench, panel layout, resize affordances, and other structural containers.

5. Local component color adjustments
   Small `style` or `styles` overrides on Mantine components when a business state needs token-based color.

## Forbidden Patterns

Do not do any of the following:

- add `components:` visual overrides in the Mantine theme for polish
- add new global `plx-theme-*` classes for buttons, cards, inputs, tabs, pills, badges, or alerts
- hardcode raw hex values in business UI code
- wrap Mantine components in a parallel visual system unless the wrapper is purely behavioral
- add a new shared token just to support one page-specific flourish

## Global Class Policy

Global classes are allowed only in these cases:

- app shell layout
- workbench layout
- plugin workbench layout
- neutral panel surface helpers shared across unrelated screens

Global classes are not allowed for:

- one-off page hero sections
- reusable state cards if Mantine `Paper` or `Alert` already works
- theme customizer cosmetics
- inline notices or badges

## Color Usage Rules

- Accent is for emphasis, selection, focus, and active state.
- Neutral surfaces define structure.
- Error, warning, and success states should stay semantic.
- Do not add decorative pattern backgrounds or component-only theme tokens.
- Text legibility wins over palette purity.

## File Structure Rules

Theme files should stay inside `src/theme/` with this split:

- `accent/`
  accent presets and persistence keys
- `core/`
  tonal math, semantic tokens, CSS variable emission
- `mantine/`
  Mantine-specific adapter and typings
- `react/`
  hooks and theme-related React controls

If a new file does not clearly fit one of those buckets, the design system is probably being stretched incorrectly.

## LLM Change Checklist

Before editing frontend design code, check these questions:

1. Is this a layout problem or a component styling problem?
2. Can Mantine already express it with props or local `styles`?
3. Can an existing `--plx-*` token express it?
4. Would a new global class create a second component styling system?

If the answer to 4 is yes, stop and choose a different approach.

## Preferred Implementation Order

When making a visual change:

1. Use Mantine props first.
2. Use local `styles` / `style` with semantic variables second.
3. Add or reuse semantic tokens third.
4. Add global SCSS only for structural layout.

## Current Accepted Exceptions

These areas are intentionally custom and may keep layout-heavy styling:

- `app/workbench/*`
- `app/plugins/detail/workbench/*`
- organizer drag-and-drop layout and row interaction feedback

These are accepted because they are application shell behavior, not generic component skinning.
