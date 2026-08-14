# App Frontend Map

This folder contains the Pluxel runtime UI application shell.

## Major Areas

- `router/`
  Route creation, route helpers, route-level screens, and file-route entries.
- `workbench/`
  Global shell chrome, panel layout state, tab state, and workbench navigation behavior.
- `plugins/`
  Plugin list, organizer, detail workbench, and config UI.
- `packages/`
  Package workbench screen and package-specific UI helpers.
- `frames/`
  App-wide providers and standalone shell wrappers.
- `notifications/`
  Notification bridge and provider wiring.
- `hooks/`
  App-level hooks only. Keep domain-specific hooks in their domain folder.
- `gqlens/`
  Generated GQLens accessors, type bindings, and runtime fetcher wiring.
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

6. Keep server state in GQLens.
   Domain hooks may derive renderable projections from a shared GQLens session, but must not mirror GraphQL data into another writable store. Keep local optimistic drafts local and invalidate the owning GQLens selection after a successful write. RPC-only data stays in a domain resource only when it has multiple consumers; do not add global topic-based invalidation or non-reactive TTL caches.

## LLM Edit Protocol

1. Identify the owning domain first.
2. Edit the narrowest domain-local file possible.
3. Promote code upward only after proving reuse.
4. When in doubt, add structure docs before adding new top-level folders.
