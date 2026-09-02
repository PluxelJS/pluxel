---
packages:
  '@pluxel/fonts':
    type: major
---

## Make Fonts Workbench mutations command-only

Return `void` from the Fonts manager and selection Workbench mutation APIs. Updated font catalogs,
selection, and limits now have one authoritative transport path through their snapshot queries,
avoiding duplicate large snapshot results during write-then-refetch flows.
