# Configuration form ownership

A section has its own TanStack Form instance because it has an independent saved baseline and
undo operation. TanStack owns values, field errors, dirty state and the section submission
lifecycle. `ConfigTabContent` provides the renderer and keeps reset defaults aligned with React
options; it has no runtime client or cache responsibility.

`useConfigForms` registers these instances in a TanStack Store atom. Its computed atom reads the
native form stores and exposes only the action dock's flags. Ordinary value edits do not publish
new flag snapshots. Registration cleanup removes the dependency when a section unmounts.

`ConfigForm` chooses the submission scope and captures each participating draft once. Current
section submissions enter through native `form.handleSubmit`; save-all builds one atomic patch
from the dirty sections. Both routes use `useConfigSave`, whose Query mutation owns the request
state, cache commit, read-model refresh and notifications. Portable plans have no executable
client schema: the runtime remains the authority for complete configuration validation.

Only the editable projection enters a patch; unrendered children keep their saved values. A
response may reset a submitted form only if its instance and draft still match the snapshot.
For save-all, validation errors require all participating snapshots to remain current because
validation can depend on otherwise clean sections. A synchronous admission guard prevents two
DOM submissions from starting writes before React has rendered the mutation's pending state.

FormGroup is useful for prefix-scoped validation and submission inside a shared form, but the
installed TanStack Form 1.33.5 API has no independent reset or saved baseline. FieldGroup provides
a composition view, with submission delegated to the parent. Neither removes our independent
persistence boundaries; adopting them here would require custom partial-reset and baseline
coordination. Introduce a group when a real shared-baseline field block needs it.
