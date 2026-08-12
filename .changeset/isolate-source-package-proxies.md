---
'@pluxel/cli': patch
'@pluxel/rolldown': patch
---

Materialize source workspace overrides as package-level proxies instead of exposing whole checkouts inside consumer projects. Reject recursive consumer/source ownership, migrate stale checkout proxies safely, and exclude generated `.pluxel` state from Vite source watching.
