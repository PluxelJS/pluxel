---
packages:
  '@pluxel/rolldown': patch
---

## Report selected Workbench runtime manifest failures

Workbench publisher and static application checks now report the selected package manifest or workspace catalog path and retain the underlying read or parse error. An inaccessible selected path no longer causes an ancestor manifest or catalog to be used; malformed JSON and YAML identify the file that failed.
