---
packages:
  '@pluxel/workbench': major
---

## Use native Cap’n Web ownership in isolated RPC tests

Remove `createLocalRpcClient()` from `@pluxel/workbench/test` and its borrowed-target proxy.
Pure RPC tests use `new RpcStub(new Target())` from `capnweb`, with the library's native
reference disposal semantics. Workbench testing types continue to describe Workbench entries and leases.
