---
packages:
  '@pluxel/services': minor
---

## Add a native Cap'n Web adapter for Commands

`@pluxel/services/capnweb` exposes `toCapnweb({ method: command })`. It creates a native `RpcTarget` class whose methods execute selected Commands with a trusted constructor context and return JSON data results.
