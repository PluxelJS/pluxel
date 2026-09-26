---
packages:
  '@pluxel/services': minor
---

## Add a native MCP Tool projection for Commands

`@pluxel/services/commands/adapters` exposes `toMcp(command)`, producing a native MCP Tool descriptor and a per-call handler. Applications own tool publication, authentication, transport and lifecycle. The adapter maps Command Results to MCP text results without exposing local causes.
