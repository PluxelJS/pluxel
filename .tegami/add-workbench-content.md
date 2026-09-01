---
packages:
  '@pluxel/core':
    type: minor
  '@pluxel/runtime':
    type: minor
  '@pluxel/rolldown':
    type: minor
  '@pluxel/runtime-static':
    type: minor
  '@pluxel/runtime-dynamic':
    type: minor
---

## Add host-rendered Workbench Content

Add `workbench.content()` and `workbench.markdown()` for build-time compiled, host-rendered Plugin
content. Content may stay static or embed typed data, buttons, and bounded Valibot forms without a
Plugin-owned React renderer. Interactive Content reuses the existing Workbench WebSocket and Cap'n Web
session for actions, refresh, and server-driven latest-state updates through `dataChanged()`.

Validate portable Markdown, slot topology, data, action input, and presentation at their build,
publication, RPC, and browser boundaries. Static Content creates no opened root; interactive Content
creates one framework-owned root per open. Content-only builds create no Module Federation producer or
React Bridge, and mixed builds exclude server schemas and handlers from the browser projection.
Destructive actions can provide explicit `confirm` text for a host-owned UX guard while authorization
and current domain preconditions remain authoritative in the action handler.

Publish content-addressed Content inventories through plugin package, static application, dynamic
distribution, and development pipelines. Commit mixed Content and federated View artifacts as one
last-known-good revision, and invalidate the existing Workbench session only after the full candidate
has committed.
