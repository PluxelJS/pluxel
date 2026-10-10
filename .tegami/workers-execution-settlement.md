---
packages:
  '@pluxel/services': minor
---

# Fence worker results on execution settlement

Worker `run()` and `runPrepared()` accept `settlement: 'execution'` to wait for task completion or worker termination before settling, including cancellation and plugin shutdown. Callers that own temporary files can release them after this fence. The default `result` behavior still rejects cancelled calls promptly while runtime retains the execution slot until exit.

If worker termination fails, execution settlement reports `EXECUTION_UNSETTLED` with the cause so resource owners retain resources that may still be in use.
