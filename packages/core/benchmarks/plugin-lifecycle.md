# Plugin lifecycle benchmark

- Recorded at: 2025-10-28T04:44:17.136Z
- Runtime: bun 1.2.22
- Target benchmark time: 350ms (warmup 150ms)

| Task | Ops/sec (mean) | Ops/sec (min) | Ops/sec (max) | ±RME % | Latency mean (ms) | p50 (ms) | p75 (ms) | p99 (ms) | Max (ms) | Runs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| load/unload A+B+C | 1,409.291 | 98.457 | 2,335.565 | 3.19 | 0.849 | 0.699 | 0.963 | 2.78 | 10.157 | 414 |
| reload PluginA | 2,222.081 | 181.457 | 3,077.453 | 1.42 | 0.5 | 0.436 | 0.489 | 2.184 | 5.511 | 700 |

> Ops/sec uses the geometric mean over the measured throughput samples. Latency statistics are in milliseconds.