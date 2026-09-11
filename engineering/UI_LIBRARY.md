# Workbench UI Library

## Current Decision

The first-party Workbench Shell and repository-maintained renderer UI use Mantine. We are not migrating to HeroUI v3, and we do not add a UI-library-neutral adapter, wrapper package, or parallel component system.

This is a decision for first-party Workbench code. A third-party renderer may still own an additional UI dependency under the existing renderer isolation contract. That technical allowance does not justify adding another official component library to this repository.

## Why Mantine Stays

- Workbench UI already uses Mantine primitives, hooks, modals, notifications, and direct component props. It does not depend on Mantine's advanced custom-component APIs such as `factory`, `useStyles`, or `createVarsResolver`.
- Mantine is part of Workbench Federation Profile 1: `@mantine/core` and `@mantine/hooks` are exact-version singleton shared modules. The Shell provides their implementation and core CSS, while producer builds validate the contract and reject duplicate core stylesheet imports.
- Every federated renderer is a separate React root. A renderer must create its own `MantineProvider`; it cannot inherit the Shell's private React Context or theme object.
- The `valibot-form` Web renderer is Mantine peer-dependent. Replacing Mantine would therefore change both the Workbench and a public form-rendering integration.

A HeroUI migration would be a platform and dependency migration, not a local JSX substitution. It would require a concrete current product, accessibility, or maintenance problem that Mantine cannot solve. Agent readability alone is not enough to justify that cost: the current application uses ordinary, explicit Mantine APIs and has local documentation for theme and renderer boundaries.

## Mantine API Discipline

Prefer ordinary Mantine components and props. For local exceptions, use a component's `style`, `styles`, `className`, or CSS variables at the call site. Do not make Mantine's internal styling model the default application architecture.

Avoid introducing `factory`, `useStyles`, `useProps`, `createVarsResolver`, `polymorphicFactory`, or a custom `StylesApiProps` contract for ordinary Workbench screens. These APIs are valid Mantine extension points, but they add a second layer of component conventions that every later reader must understand.

Use Mantine's advanced extension APIs only when all of the following are true:

- a genuinely reusable, Mantine-native component is required;
- at least two unrelated call sites need the same component contract;
- standard Mantine composition and local styling cannot express the behavior clearly; and
- the component's slots, props, styling ownership, and accessibility behavior can be documented in one place.

Do not introduce a custom primitive to hide a single screen's layout or visual preference. Prefer deleting the abstraction when its only benefit is shorter JSX or speculative future reuse.

## Working Rules

- First-party Workbench UI imports Mantine directly and uses its primitives, hooks, props, and local `styles` before introducing custom CSS.
- `packages/workbench-app/src/theme/mantine/theme.ts` is direct Mantine theme configuration. It is deliberately named as such, not as an adapter.
- The theme directory may define product semantic color tokens for layout and neutral surfaces. It does not create a second component skin system.
- Each federated Mantine renderer installs `MantineProvider` inside its own root. It must not import `@mantine/core/styles.css`; the Shell loads it once.
- Do not introduce HeroUI, Tailwind, React Aria, or library-neutral UI abstractions into first-party Workbench code without an approved replacement decision.

## Re-evaluation

Revisit this decision only when a concrete, current requirement cannot be met with Mantine or its supported ecosystem. A proposal must identify the affected renderer roots, Federation shared-module and CSS ownership changes, `valibot-form` impact, migration owner, and removal path for the old implementation. Do not keep two first-party component systems during an open-ended trial.

## Related Sources

- [`FRONTEND.md`](FRONTEND.md) owns Workbench renderer and Federation behavior.
- [`../docs/workbench/renderer-resources.md`](../docs/workbench/renderer-resources.md) owns the public renderer Provider and stylesheet rules.
- [`../packages/workbench-app/src/theme/README.md`](../packages/workbench-app/src/theme/README.md) owns local theme editing rules.
