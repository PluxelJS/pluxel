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
