# Plugins Frontend Map

This directory is the frontend surface for plugin browsing, detail, config, and organization.

## Directory Roles

- `catalog/`
  Plugin navigation, search/filter tokens, grouped drag/drop organization, and navigation chrome.
- `pluginOverview.tsx`
  Shared management-client overview snapshot consumed across plugin screens; it does not own a second writable store.
- `pluginStatusActions.ts`
  RPC-backed auto-start policy and process-session lifecycle operations.
- `detail/`
  Single-plugin screen, workbench composition, scoped context, and detail-only `cards/controls`.
- `config/`
  Config form orchestration, schema grouping, saved-state handling, the shared RPC config resource, and form TOC helpers.

## Hard Rules

1. `detail/` owns plugin-specific screen composition.
   Do not route plugin detail screens through compatibility wrapper files.

2. `catalog/` owns filtering and overview projection.
   Do not duplicate search token parsing or overview shaping outside `catalog/`.

3. `catalog/organizer/` owns drag/drop rendering only.
   Keep RPC, notifications, and persistence logic outside unless strictly needed for DnD itself.

4. `config/` owns config submission flow.
   Reuse its helpers and config resource instead of adding ad-hoc schema caches, schema sorting, anchor logic, or saved-state badges elsewhere.

5. Shared code must be truly shared.
   If only one area uses it, keep it local to that area.

## LLM Edit Protocol

When editing plugin UI:

1. Decide whether the change belongs to `catalog/`, `detail/`, `config/`, `pluginOverview.tsx`, or `pluginStatusActions.ts`.
2. Change the narrowest layer first.
3. Prefer deleting compatibility wrappers instead of adding new ones.
4. Add a new folder only when at least two files would immediately live under it.
