---
'@pluxel/runtime': minor
'@pluxel/runtime-dev': patch
'@pluxel/rolldown': minor
'@pluxel/canvas': minor
'@pluxel/echarts': minor
---

Add a root-owned shared worker-task pool with typed artifact declarations, bounded fair scheduling,
owner cancellation, and controlled native dependency residuals. ECharts now renders through this pool
by default while Canvas exposes narrow resource-limit validation for off-thread adapters.
