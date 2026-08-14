---
'@pluxel/canvas': minor
'@pluxel/echarts': patch
'@pluxel/rolldown': minor
'@pluxel/runtime-dev': patch
---

Add worker-safe Canvas and bounded Pretext entry points backed by detached Canvas/Fonts policy
snapshots. ECharts now consumes the Canvas worker adapter without directly depending on the native
binding, and Node artifacts validate native residual ownership at each package boundary.
Owner-aware native bridges preserve that boundary under strict package-manager dependency layouts.
