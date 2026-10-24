## valibot-form@1.2.0

### Refresh shared external dependency ranges

Upgrade the shared runtime and tooling catalogs and use caret ranges for compatible stable releases. Align source consumers through the bundled pncat policy, including Elysia 2 beta.26 and current TypeBox. Preserve explicit prerelease, native pairing, patched dependency, and public peer compatibility exceptions.

Rebuild Workbench producer artifacts against the Mantine 9.7.1 compatibility set; the Shell and remote producers continue to require identical shared UI versions.

Generate starter catalogs through pncat using the same core version policy and Tegami package versions.

Handle declared optional dependencies whose platform packages are not installed, including dangling package-manager links, while keeping actual source imports strictly validated.

### Preserve scroll position when focusing collection inputs

Array and record draft inputs retain keyboard focus without scrolling their containing panels or the page when the form renders or entries change.

### Refresh workspace dependencies and generated tooling

Align shared UI consumers and generated project catalogs with React 19.3.1,
Mantine 9.7.3 and Vite+ 1.3.0. Rebuild precompiled Workbench assets against the
same shared versions. Refresh the documentation dependencies and update generated
project tool pins to the current supported Node 24 and pnpm 11 releases, hk 2.7.0
and Pitchfork 2.32.0.

Update the Federation Vite producer to 1.23.5, browser clients to Playwright
1.64.1, file watchers to Chokidar 6 and rendering dependencies to Takumi 2.17
and Pretext 1.0. Refresh the remaining workspace runtime and development catalogs.

The HTTP service now requires Elysia 2.0.0-rc.0. Use `onRequest` and `onError`
instead of the beta `request` and `error` hooks. Physical lifecycle registration
through `onStart` and `onStop` remains unavailable to Plugin-owned applications.

Canvas's exported Pretext helpers follow the 1.0 contract:
`layoutNextLine(prepared, maxWidth, cursor?)` and
`layoutNextLineRange(prepared, maxWidth, cursor?)`. Rich-inline source offsets
use `sourceStart` and `sourceEnd`; prepared handles expose read-only segments.

### Align the official Pluxel release line

Release the public framework packages and official Plugins together at 1.2.0. This is the maintainer's explicit version choice for the currently unpublished release; existing breaking-change descriptions remain part of the release notes. Future releases retain semver-based group bumps, and newly introduced pre-1.0 packages join the current release line.

Independent official Plugin packages use `@pluxel/plugin-*`. Update dependency names, package imports, subpath imports and application declarations together. This naming change preserves Plugin class names, exports and constructor declarations. Core, Host, Services, Workbench and tooling packages retain their existing names. Private Plugins remain workspace-only.

A Plugin's canonical identity includes its package entry. Rebuild consumer artifacts and explicitly review saved configuration, startup intent and Workbench state keyed by the previous identity before deployment; no old-name alias or automatic runtime migration is installed.

Carry forward the unpublished release notes. Earlier Host Dev notes belong to Host-vite; the former Typst Markdown extension belongs to the consolidated Markdown package. Their original explanatory bodies remain available alongside the later migration notes.

### Acquire remote values only after React commit

`useRemoteValue` no longer starts reads or subscriptions during render. StrictMode replay shares
one owner; dependency changes isolate reads and late subscriptions are released after unmount.
The imperative `createRemoteValue` retains eager acquisition and explicit disposal.

### Type AutoForm options against input drafts

Schema forms now infer Valibot input values instead of transformed outputs. Both form modes
accept typed TanStack options and infer submit callbacks. `submit()` returns its completion
Promise and propagates callback rejection; DOM-submit callbacks remain responsible for displaying failures.

### Refresh supported tooling and generated projects

Update runtime, rendering, validation and tooling dependencies together across the published packages and generated projects.
New projects use Elysia 2 beta.19 and TypeScript 7, with TypeBox 1.3.23 pinned for Elysia eager schema compilation.
Update fixture dependencies while retaining the tested VFS release until its newer release restores trusted-publisher evidence.

Read extracted HTML CSS through Takumi’s current `css` result field, avoiding its deprecated alias and per-process warning.

### Share resolved defaults across the form

Schema defaults are resolved once for the controls, form context and reset, keeping values from dynamic default factories consistent. An explicit `defaultValues: undefined` uses schema defaults just like an omitted option.

### Bind nested form fields to TanStack paths

Object, array, union and record editors now bind addressable child fields directly to TanStack Form, preserving independent interaction metadata and field errors. Array operations use TanStack metadata handling; reset also clears local collection drafts and inactive union values, including resets invoked from submission callbacks.

Workbench config and Content action forms display server errors at mounted field paths, retain unaddressable issues in a summary, and permit correction and retry. Inputs associate field errors with their accessible descriptions.

Union and Record leaf edits avoid rerendering unchanged sibling controls. Picklist options use Mantine's current render callback, and multi-value picker errors use Mantine's input wrapper to associate the actual input with its error message.

Literal record keys retain their original meaning. Unaddressable top-level keys are shown as read-only instead of writing to an incorrect nested path; their original values remain in submitted data.

## valibot-form@1.1.0

### Preserve scroll position when focusing collection inputs

Array and record draft inputs retain keyboard focus without scrolling their containing panels or the page when the form renders or entries change.

### Acquire remote values only after React commit

`useRemoteValue` no longer starts reads or subscriptions during render. StrictMode replay shares
one owner; dependency changes isolate reads and late subscriptions are released after unmount.
The imperative `createRemoteValue` retains eager acquisition and explicit disposal.

### Type AutoForm options against input drafts

Schema forms now infer Valibot input values instead of transformed outputs. Both form modes
accept typed TanStack options and infer submit callbacks. `submit()` returns its completion
Promise and propagates callback rejection; DOM-submit callbacks remain responsible for displaying failures.

### Refresh supported tooling and generated projects

Update runtime, rendering, validation and tooling dependencies together across the published packages and generated projects.
New projects use Elysia 2 beta.19 and TypeScript 7, with TypeBox 1.3.23 pinned for Elysia eager schema compilation.
Update fixture dependencies while retaining the tested VFS release until its newer release restores trusted-publisher evidence.

Read extracted HTML CSS through Takumi’s current `css` result field, avoiding its deprecated alias and per-process warning.

### Share resolved defaults across the form

Schema defaults are resolved once for the controls, form context and reset, keeping values from dynamic default factories consistent. An explicit `defaultValues: undefined` uses schema defaults just like an omitted option.

### Bind nested form fields to TanStack paths

Object, array, union and record editors now bind addressable child fields directly to TanStack Form, preserving independent interaction metadata and field errors. Array operations use TanStack metadata handling; reset also clears local collection drafts and inactive union values, including resets invoked from submission callbacks.

Workbench config and Content action forms display server errors at mounted field paths, retain unaddressable issues in a summary, and permit correction and retry. Inputs associate field errors with their accessible descriptions.

Union and Record leaf edits avoid rerendering unchanged sibling controls. Picklist options use Mantine's current render callback, and multi-value picker errors use Mantine's input wrapper to associate the actual input with its error message.

Literal record keys retain their original meaning. Unaddressable top-level keys are shown as read-only instead of writing to an incorrect nested path; their original values remain in submitted data.

## valibot-form@1.0.0

### Initial open-source release

Publish the supported Pluxel packages together at 1.0.0. Current package contracts and development workflows are documented in the repository.
