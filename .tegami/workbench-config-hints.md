---
packages:
  '@pluxel/workbench': patch
---

## Cleaner config field hints

A config field's description and the hints Workbench adds after it (value
source, effective value, resolved default) are joined with a single stop, so a
description that already ends a sentence no longer prints `。。`. When nothing is
saved, the resolved default is shown as the empty control's placeholder (the
option label for a select) instead of a `解析为 …` note, unless the field has a
placeholder of its own.
