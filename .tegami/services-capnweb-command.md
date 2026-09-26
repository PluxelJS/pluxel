---
packages:
  '@pluxel/services': minor
---

## Add a native Cap'n Web adapter for Commands

`@pluxel/services/commands/adapters` exposes `toCapnweb({ method: command })`. It creates a native `RpcTarget` class whose methods execute selected Commands with a trusted constructor context and return JSON data results.
The adapter rejects method and data keys that Cap'n Web cannot preserve and checks its encoder before reporting a successful result.
