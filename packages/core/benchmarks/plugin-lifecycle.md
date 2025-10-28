# Plugin lifecycle benchmark

- Recorded at: 2025-10-28T04:32:12.533Z
- Runtime: bun 1.2.22
- Target benchmark time: 350ms (warmup 150ms)

| Task | Ops/sec (mean) | Ops/sec (min) | Ops/sec (max) | ±RME % | Latency mean (ms) | p50 (ms) | p75 (ms) | p99 (ms) | Max (ms) | Runs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| load/unload A+B+C | 1,820.451 | 126.443 | 2,591.835 | 1.82 | 0.623 | 0.525 | 0.588 | 2.499 | 7.909 | 562 |
| reload PluginA | 2,574.502 | 220.613 | 3,478.842 | 1.4 | 0.433 | 0.374 | 0.423 | 1.998 | 4.533 | 809 |

> Ops/sec uses the geometric mean over the measured throughput samples. Latency statistics are in milliseconds.