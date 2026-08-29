---
packages:
  '@pluxel/core':
    type: major
  '@pluxel/test':
    type: major
  '@pluxel/cli':
    type: patch
  '@pluxel/runtime':
    type: major
  '@pluxel/runtime-static':
    type: major
  '@pluxel/runtime-dynamic':
    type: major
  '@pluxel/create':
    type: patch
---

## Expose the dependency graph and systemd-style lifecycle control

Add a strict browser-safe Management snapshot for Plugin nodes, required and optional relations,
provider resolution, and committed graph membership. Read the projection atomically from the
coordinator's last committed view without materializing absent Plugins, and preserve stable graph
rejection signals when Core verification rejects a mutation.

Use the snapshot across the official Workbench Plugin detail and lazy dependency graph page, with
typed incoming/outgoing relations, declaration placeholders, status-aware inspection, canonical
focus links, last-known-good refresh behavior, and provider-to-consumer layout. Present Plugin detail
relations as compact current-Plugin lists: show only the opposite endpoint's display name in the row,
reserve badges for actionable or non-default facts, summarize active and inactive dependents in one
section, and retain canonical identity in tooltips and navigation targets. Keep the graph a
focused read-only audit surface: lay out connected relation groups with Dagre and native SVG/HTML,
pack relation groups across a balanced two-dimensional canvas, provide pointer-centered zoom and
background pan without canvas scrollbars, open relation-free Plugins only from an on-demand overlay,
focus a selection's immediate dependency neighborhood, overlay inspection without shrinking the
canvas, and remove the graph-editor runtime, MiniMap, node drag/connect affordances, and edge-wide
selection scans.

Make mutable dependency resolution explicit in each compact required-dependency row: present following
the provider default as a real consumer choice, keep per-consumer overrides separate from the opposite
provider-default policy, and use display names for choices while retaining structured addresses for
mutations. Expose these as distinct consumer-requirement and provider-policy client operations. Derive
the abstract token for a provider-policy mutation from its provider owner on the server instead of
accepting a redundant caller-supplied token, and exclude Forks from global-default choices.

Replace the mixed enable/disable lifecycle contract with a systemd-style model. Persist only `autoStart`,
keep `inherit | run | stop` intent inside the process-owned coordinator, and project effective desired,
activation reason, and observed lifecycle as distinct facts. Changing auto-start policy preserves the
current process desire; start and stop affect only the current host session; restart changes neither.
Carry session intent through HMR and reconciliation, activate required provider closure without changing
provider policy, and honor explicit provider stop across its required dependent closure. Split Management
and command contracts into auto-start policy mutations and lifecycle commands, remove the old aliases and
RuntimeState v4 shape, and let Workbench render only committed facts without optimistic running state.
Render auto-start as a compact labeled Switch, keep current-session commands in a separate button group,
and distinguish start, retry, stop, and restart with stable action tones without relying on color alone.
Admit start inside the coordinator against its pinned catalog and RuntimeState view: an unavailable target
returns stable `start_unavailable` without writing session intent, while stop can still clean up an existing
unavailable target. Preserve the precise `node_unavailable` state-mutation result instead of collapsing it
into a generic rejection. When clearing policy or stopping releases a node's final projection reference,
return the canonical `autoStart: false`, `sessionIntent: inherit`, stopped control snapshot instead of
throwing after the successful commit.

Route Plugin status overviews, group membership reads, static reports, and dynamic HMR reports through one
coordinator-pinned committed projection, so no response can splice catalog, RuntimeState, session intent,
Core adjacency, and running facts from different revisions. Remove the unused dynamic-loader dependency
inspector and runtime resolver facades; tests that need white-box lifecycle observation now read the Core
Plugin service directly instead of keeping test-only loader APIs alive.

Keep static Vite document navigation working for canonical Plugin focus URLs whose identity segments
contain filename punctuation, while leaving non-document asset and Vite-internal requests with Vite.
Observe Vite's callback-style srvx request and shutdown promises so rapid navigation cancellation or
concurrent close cannot become a process-level unhandled rejection. Propagate browser cancellation
into SSE writers and observe asynchronous log drains so repeatedly entering and leaving the log view
cannot keep writing to a cancelled stream or terminate the Node host. Replace the Workbench event
stream's fire-and-forget third-party Fetch writer with the Runtime-owned cancellation-aware SSE
lifecycle, so response cancellation clears keepalive work and runs resource cleanup exactly once.
Treat browser-state v4 as the only accepted Workbench persistence schema and restore defaults for every
other version instead of carrying v3 dual-read migration branches. Drive temporary editor-group maximize
state declaratively through the grid adapter's canonical layout API, removing the stale imperative
`restoreEditorGroups` contract. Observe every browser navigation result at one boundary: consume only the
`undefined` rejection used for superseded navigation cancellation and report real failures, preventing
rapid clicks from becoming process-level unhandled rejections.

Remove the inert Core test config-handle `enable/disable/enabled` methods. Core-only tests now express
graph membership exclusively with `add/remove/commit`; Runtime tests use explicit auto-start policy and
session lifecycle commands, so examples and generated plugin tests no longer teach a third, non-functional
meaning of “enabled”.
