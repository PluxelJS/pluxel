---
packages:
  '@pluxel/services': major
---

## Expose the Elysia application directly and keep its dispatcher internal

Use `ElysiaApp`, `elysia()` and `createElysiaHandler(host)` from
`@pluxel/services/elysia`. Node applications use `listenElysia(host, options?)`
from `/elysia/node`; the srvx listener owns Host shutdown and needs no duplicate
fetch handler. Vite applications use `elysiaDevelopment()` from `/elysia/vite`.
Remove the HTTP service aliases and public dispatcher/carrier extension surface.
Route ownership, cancellation and WebSocket drain semantics remain unchanged.
