---
packages:
  '@pluxel/commands': major
---

## Isolate Command protocol entry points

Replace `@pluxel/commands/adapters` with `@pluxel/commands/mcp` and `@pluxel/commands/capnweb`. The Cap’n Web peer is optional; kernel and MCP consumers no longer need to install or load it. MCP SDK remains an optional type dependency.
