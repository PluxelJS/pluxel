# Theme Architecture

This directory is intentionally split by responsibility. The goal is to make later edits obvious for both humans and LLMs.

## Directory Map

- `accent/`
  Source-of-truth accent presets and storage keys.
- `core/`
  Palette math, semantic tokens, and CSS variable emission.
- `mantine/`
  Mantine-only adapter layer. This must stay thin.
- `react/`
  Runtime hooks and theme-related UI controls.
- `index.ts`
  Public export surface for the rest of the app.

## Hard Rules

1. Mantine owns component design.
   Do not restyle Mantine primitives globally in `mantineAdapter.ts`. This file may define colors and theme metadata only.

2. We own layout, not component skins.
   Global classes are allowed for app shell/workbench layout and neutral panel surfaces.
   Global classes are not allowed for custom button/input/card/tabs appearances.

3. Product color flows through semantic tokens.
   Components must consume `--plx-*` semantic variables or Mantine props.
   Do not hardcode raw hex colors in business components.

4. Color-only customization stays local.
   If a component only needs color differences, prefer Mantine `color`, `variant`, `styles`, or inline CSS variables.
   Do not create a new global class for that.

5. New shared primitives require proof.
   Before adding a new token, mixin, or class, confirm that at least two unrelated call sites need the same contract.

6. Do not wrap a single Mantine field just to make it look custom.
   Avoid `Paper`/custom bordered `Box` around one `TextInput`, `Select`, or `Button` row unless the wrapper solves layout grouping, scrolling, or section separation.

## Edit Protocol For LLMs

When changing frontend visuals, follow this order:

1. Ask whether the change is layout or component styling.
2. If it is component styling, use Mantine first.
3. If Mantine is insufficient, add or reuse semantic color tokens.
4. Only add global SCSS when the change is structural layout shared across screens.

Avoid these patterns:

- adding `components:` overrides in Mantine theme for visual polish
- adding new `plx-theme-*` classes for one component family
- adding decorative pattern or state-skin tokens for individual components
- duplicating panel/card/input visuals in SCSS when Mantine already provides them
- introducing a second source of truth for colors outside `accent/` and `core/`
- wrapping a lone search/select control in an extra bordered container just for polish

## Current Boundaries

- `mantine/mantineAdapter.ts`
  Generates Mantine palettes from our accent source and stores metadata in `theme.other`.
- `core/themeModel.ts`
  Emits the semantic CSS variable contract used by app layout, neutral surfaces, and shared selection states.
- `src/styles/theme/_primitives.scss`
  Should stay minimal. Today it is limited to app root defaults and neutral shared panel surfaces.

## Related Doc

See `packages/workbench-app/color-design.md` for the product-level design policy and non-negotiable rules.
