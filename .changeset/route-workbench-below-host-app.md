---
'@pluxel/runtime': minor
'@pluxel/runtime-static': minor
'@pluxel/runtime-dynamic': minor
---

Allow hosts to mount Workbench navigation below a configurable `workbench.uiBasePath`, while
preserving `/` as the default. Keep packaged Workbench assets routed through the runtime and leave
unowned application navigation available to static and dynamic host SPAs.
