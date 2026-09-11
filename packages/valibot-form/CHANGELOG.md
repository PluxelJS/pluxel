## valibot-form@1.0.1

### Preserve scroll position when focusing collection inputs

Array and record draft inputs retain keyboard focus without scrolling their containing panels or the page when the form renders or entries change.

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
