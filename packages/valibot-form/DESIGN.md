# valibot-form Design Notes

## Goals

- Practical first: configuration forms with moderate data size, fast interaction, clear defaults.
- Metadata-driven: keep schema as the single source of truth via `f.*` meta actions.
- Minimal UX friction: reduce steps, keep layout readable, avoid unnecessary UI variants.

## Non-goals

- Backward compatibility with legacy `f.*` signatures.
- Large data optimizations (virtual list, infinite scroll).
- Highly stylized UI themes; stick to Mantine defaults + layout guidelines.

## Architecture Overview

- **Core**
  - `fields.ts` extracts renderable nodes from Valibot schemas.
  - `meta.ts` defines UI meta contracts (layout, labels, help, picklist configs).
  - `schema.ts` reads metadata from schema pipe.
- **Web**
  - `AutoForm` orchestrates form context and section planning.
  - `FieldRenderer` routes nodes to concrete renderers.
  - Renderers are type-specific and keep UI logic localized.
- **Demo**
  - Organized by intent (core, arrays, records, unions, real-world).
  - Playground is opt-in to avoid accidental state resets.

## Metadata Strategy (`f.*`)

- `formMeta` controls label, help, hint, badge, visibility, layout, section.
- Type meta (`stringMeta`, `numberMeta`, `picklistMeta`, etc.) describes input behavior.
- Section meta is normalized; fields can self-assign a section without extra config.

## Rendering Principles

- **Clarity over variety**: prefer a single reliable control for each case.
- **Contextual actions**: default add labels use `itemLabel` or field label so deep nesting is clear.
- **Compact layouts**: simple fields auto-flow into columns only when density supports it.
- **Errors in place**: keep error messages near the control, allow multi-line output.

## UX Decisions

- Arrays/records default to table or compact list when items are primitive.
- Inline add row enabled only when it reduces clicks (primitive types + editable key).
- Union branches preserve shared fields and reset branch state only when required.
- Literal values render as read-only by default unless overridden via meta.
- Demo uses fixed main layout on wide screens so form scrolls independently and debug stays visible.

## Demo Design Guidelines

- Follow `LAYOUT_DESIGN_GUIDELINES.md` for spacing, grouping, and hierarchy.
- Keep cases comprehensive but non-redundant; each case should prove a capability.
- Favor usable defaults over exhaustive UI permutations.

## Testing Focus

- Core extraction/metadata parsing
- Union branch behavior and array renderer behavior
- Avoid regressions in nested/compound schemas
