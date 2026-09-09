---
packages:
  valibot-form:
    type: patch
---

## Bind nested form fields to TanStack paths

Object, array, union and record editors now bind addressable child fields directly to TanStack Form, preserving independent interaction metadata and field errors. Array operations use TanStack metadata handling; reset also clears local collection drafts and inactive union values, including resets invoked from submission callbacks.

Workbench config and Content action forms display server errors at mounted field paths, retain unaddressable issues in a summary, and permit correction and retry. Inputs associate field errors with their accessible descriptions.

Union and Record leaf edits avoid rerendering unchanged sibling controls. Picklist options use Mantine's current render callback, and multi-value picker errors use Mantine's input wrapper to associate the actual input with its error message.

Literal record keys retain their original meaning. Unaddressable top-level keys are shown as read-only instead of writing to an incorrect nested path; their original values remain in submitted data.
