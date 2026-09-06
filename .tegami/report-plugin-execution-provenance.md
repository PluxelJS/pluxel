---
packages:
  '@pluxel/runtime':
    type: major
  '@pluxel/rolldown':
    type: minor
  '@pluxel/runtime-dynamic':
    type: minor
  '@pluxel/runtime-static':
    type: minor
---

## Report canonical Plugin execution provenance

Replace the ambiguous Plugin status source summary with a closed, browser-safe execution snapshot.
Canonical package and source identity now comes exclusively from the Plugin definition address, while
execution independently distinguishes static deployment bundles, static catalogs, dynamic fixed
imports, source-graph HMR, entry-only HMR, and honestly unreported routes.

Expose the most recent route update result separately. Distinguish a rejected update that retained the
previous catalog, commit or lifecycle issues after the new catalog became authoritative, and a failed
full application replacement that successfully restored the previous definition through a fresh
compensation host. Failed Plugin generations still roll back their partial effects, without pretending
that an already-published catalog was rolled back. Upgrade the Management protocol to v4, validate and
deeply freeze all new snapshot unions, and keep physical module IDs, file URLs, and absolute paths on
the server.

Use exact, positive Rolldown semantic facts in the active Vite closure to distinguish source modules
from built entries. File extensions, package paths, and negative source matches do not infer either
state; missing or conflicting evidence remains unreported. Candidate transforms, evaluation, and
classification run in an async-scoped artifact generation that commits only after acceptance or
discards its isolated facts on failure. Concurrent ambient transforms remain independently authoritative,
and per-module version checks prevent an older candidate from overwriting their newer facts. Static and
dynamic routes publish their exact artifact and update boundaries without adding an online source/built
mode switch, changing canonical Plugin identity, leaking physical paths, or treating every package
installed during development as source-HMR capable.

Dynamic shutdown now stops admission and drains in-flight startup, batches, direct execution/warmup,
and Workbench Content refreshes before disposing provenance sources or server resources. Work admitted
before shutdown may finish its atomic publication, but cannot emit a late browser reload.
Both host-owned and self-owned dynamic source routes keep `.pluxel` globally ignored by the main Vite
watcher. The route owns a supplemental watcher only for declared source roots below `.pluxel`, and still
admits events through the exact file or positive include filter, so atomically republished managed entries
use the same real HMR batch path without admitting unrelated persistence, installs, or caches into Plugin batches.

Static Vite now reports `catalog-hmr` for source, built, and honestly unreported artifacts because all
three are updated through the watched application module closure and the live catalog transaction.
Workbench labels this boundary as “目录 HMR” and separately explains that entry or application-config
changes rebuild the host. `application-reload` remains reserved for the recent result of a successful
fresh-host compensation after a failed full application replacement.
