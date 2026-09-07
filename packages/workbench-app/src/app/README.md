# App Frontend Map

This folder contains the Pluxel runtime UI application shell.

## Major Areas

- `router/`
  Route creation, link adaptation, recoverable route error boundaries, and thin file-route entries.
- `workbench/`
  Workspace state and layout; `shell/` owns chrome, document rendering, editor groups, and persistence.
- `plugins/`
  Plugin list, organizer, detail workbench, and config UI.
- `plugin-graph/`, `home/`, `security/`, `log_viewer/`
  Host-owned screens and their domain-local models. Package management belongs to its Plugin, not this Shell.
- `frames/`
  App-wide providers and standalone shell wrappers.
- `notifications/`
  Notification bridge and provider wiring.
- `hooks/`
  App-level hooks only. Keep domain-specific hooks in their domain folder.
- `bootstrap.ts`
  Global runtime bootstrap for schema vendors and app startup side effects.

## Hard Rules

1. Keep route files thin.
   Route entries should compose screens, not contain business logic.

2. Keep workbench generic.
   `workbench/` should not absorb plugin-specific business rules.

3. Keep domain logic local.
   If only plugins use a helper, keep it under `plugins/` instead of lifting it to `app/hooks` or `components/`.

4. Prefer deleting pass-through files.
   If a file only re-exports one symbol for one internal consumer, remove the layer.

5. Public barrels are intentional; internal detours are not.
   Keep a barrel only for real package exports. Avoid internal `index.ts` files that only forward one file for one caller.

6. Keep server state behind the public management client.
   Domain hooks may retain the last immutable snapshot while a refresh is in flight, but must not mirror it into another writable global store. Keep local optimistic drafts local and refresh the owning management domain after a successful write.

7. Scope failures and state to their owners.
   Each workspace document has its own route error boundary. Path changes reset errors, not the Shell. Persist only sanitized workspace UI state, coalesce writes, and flush pending changes on page hide or teardown.

## LLM Edit Protocol

1. Identify the owning domain first.
2. Edit the narrowest domain-local file possible.
3. Promote code upward only after proving reuse.
4. When in doubt, add structure docs before adding new top-level folders.
