# core-di vs diod benchmark

- Time per task: 1000ms
- Warmup per task: 300ms
- Rounds (median): 3
- Chain size: 64
- Star size: 128

| Scenario | core-di ops/s | diod ops/s | core-di us/op | diod us/op | Speedup | Winner |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Cold full build chain x64 | 14350 | 6479 | 69.69 | 154.34 | 2.21x | core-di |
| Cold build + first resolve chain x64 | 8920 | 4533 | 112.11 | 220.59 | 1.97x | core-di |
| Hot no-op build chain x64 | 3932234 | 828144 | 0.25 | 1.21 | 4.75x | core-di |
| Hot add/remove leaf star x128 | 106774 | 99109 | 9.37 | 10.09 | 1.08x | core-di |
| Hot base retarget star x128 | 16331 | 10016 | 61.23 | 99.85 | 1.63x | core-di |
| Hot replace root with old-token alias star x128 | 16795 | 9431 | 59.54 | 106.04 | 1.78x | core-di |
| Hot resolve base singleton star x128 | 15381142 | 12573675 | 0.07 | 0.08 | 1.22x | core-di |
| Hot resolve transient chain x32 | 852249 | 85618 | 1.17 | 11.68 | 9.95x | core-di |
