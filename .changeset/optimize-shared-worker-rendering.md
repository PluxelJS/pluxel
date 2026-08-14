---
'@pluxel/canvas': minor
'@pluxel/echarts': patch
'@pluxel/fonts': patch
'@pluxel/runtime': minor
---

Add explicit ArrayBuffer ownership transfer to shared worker tasks and bound jobs that are waiting
for their artifact route. Reduce worker scheduling, Canvas snapshot, font selection, ECharts option
traversal, native image input, and encoded output overhead while preserving caller ownership.
