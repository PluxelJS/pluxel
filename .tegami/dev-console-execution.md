---
packages:
  '@pluxel/host-dev': major
  '@pluxel/host': minor
  '@pluxel/management': patch
  '@pluxel/services': minor
  '@pluxel/workbench': patch
  '@pluxel/rolldown': patch
---

## Define explicit console executions with one inferred context

Add `defineDevConsole()` and move execution id, input and cancellation signal onto `dev`.
Lifecycle and configuration operations return address-only Host report snapshots shared with
Management, preserving lifecycle failures and saved-but-not-applied outcomes. Inspect application
update failures through `dev.updates.latest()`, including failures before a Plugin enters the catalog.

## Retain development startup injection and URL presentation

Host and service Vite integrations accept immutable startup binding snapshots. Workbench and HTTP
attachments present the active shell mount and Portless application origin across Host replacement.

Prepared development artifacts now activate at graph acceptance before replacement Plugin startup.
Workbench Content-to-View updates retain the same Host and can start against their new artifacts;
pre-acceptance graph rejection still discards candidate artifacts. Shell navigation no longer claims
CSS requests whose Accept header also includes a wildcard.

## Admit installed Workbench artifacts during development

Development attachments receive the exact candidate module closure and selected definitions.
Installed Plugin inventories now participate in the same artifact preparation, acceptance, and
withdrawal as source Plugins. Unselected exports do not require their artifact directories.
Rejected candidates retain accepted artifacts; Host compensation reuses accepted plans and reports
failure if their immutable disk revisions are no longer available. Physical installed modules can
contribute positive prelowered ABI facts without enabling source lowering for third-party packages.

Prebuilt Workbench shell assets carry Vite's HTML ignore markers, preventing false source-module
pre-transform failures while preserving the HTML pipeline, Vite client injection, and source Shell HMR.
