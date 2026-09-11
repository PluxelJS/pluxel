## @pluxel/runtime@1.1.0

### Align development console polymorphism with test hosts

Add dependency inspection and default/consumer provider selection, persistent fork creation and removal, and synchronous running-state queries to the development console. Abstract requirements and typed fork targets use the existing identity and lifecycle rules; mutations return production domain results and application reports.

### Recover failed candidates without mixing runtime and Workbench generations

Prepare Workbench artifacts before catalog acceptance and activate them at the graph commit boundary. Rejected candidates preserve the running generation's Content and producer builds; superseded background validations cannot publish.

Static Vite retains failed-candidate recovery dependencies independently of the committed graph, including new files, missing imports and package installation metadata. Fixing those dependencies automatically retries the candidate and restores dependent plugins.

Management clients can read and subscribe to independent update attempts. Workbench displays batch progress and bounded failure details in its header, preserving the distinction between rejected updates and current plugin health. Revoked Workbench sessions automatically reload the document after cleanup, with a bounded retry interval and manual fallback for repeated refreshes or authentication failures.

### Retain and expose Plugin lifecycle failures

Plugin status and management commands include lifecycle failure codes and messages until recovery or removal, including across unrelated commits. Runtime logs record the affected Plugin, phase and serialized error. Workbench distinguishes startup failures and dependency blocking from pending activation, keeps error notifications open, and lets users copy the notification and full lifecycle report. PGlite initialization errors identify the data directory and explain why retrying a Plugin cannot recreate a failed shared backend.

### Prefer declared Workbench route paths and diagnose collisions

Workbench exposes all committed routes in its global layout, including parameterized routes and pages outside navigation. The Shell uses declared paths below its UI base URL when unambiguous. Overlapping routes from different plugin instances and reserved Shell paths use canonical plugin URLs with visible collision diagnostics. Canonical URLs remain available, and aliases are recomputed after publication changes.

### Fill the available Workbench space for federated pages

Give federated View and Attachment renderers a sized mount container. Pages now fill their editor pane instead of shrinking to their content width, and Pane Kit responds to the actual available width when choosing columns or drawers.

## @pluxel/runtime@1.0.0

### Initial open-source release

Publish the supported Pluxel packages together at 1.0.0. Current package contracts and development workflows are documented in the repository.
