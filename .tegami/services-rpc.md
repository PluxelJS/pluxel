---
packages:
  '@pluxel/services': minor
  '@pluxel/rolldown': minor
---

## Publish Commands to an explicit RPC catalog

Add `@pluxel/services/rpc` with build-bound Command publications, exact contract access,
generation-pinned sessions, discovery, and bounded JSON result projection. The service is
installed explicitly and does not expose the root Command catalog.
Discovery shows only methods currently allowed by publication authorization, including in
generated client declarations; an API with no allowed methods is hidden.

The Rolldown and Vite RPC publication pass derives authorization hashes from schema constraints
and business values while excluding presentation annotations at schema positions.
Generated clients retain intentional `unknown` success data for callers to narrow, while
rejecting `unknown` inputs and `any` values at build time.
Boolean success literals remain distinct in authorization hashes, and class instance
success types fail generation because the JSON wire cannot deliver them.
Static Command input generation now supports booleans, numbers, arrays, nested objects,
optional fields, and Transform wire schemas while preserving static JSON constraints.
