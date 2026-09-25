---
packages:
  '@pluxel/services': minor
---

## Publish Commands through an explicit MCP service

Add `@pluxel/services/mcp` with an owner-bound `expose()` method, current authorization checks, SDK-native tool discovery and execution, structured output validation, and generation-owned cleanup. Calls recheck publication after asynchronous authorization, including denied decisions. Authentication must return a non-null principal for each request. Context factories must return plain data records without reserved fields. Installation requires an existing authenticated MCP SDK server; root Commands are not exposed automatically.
