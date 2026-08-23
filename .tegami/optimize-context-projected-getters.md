---
packages:
  '@pluxel/context':
    type: patch
---

## Speed up cached Context projections

Compile projected properties into scope-specific getters that read private Context state directly,
while keeping full receiver and foreign-kernel validation on explicit capability resolution. Inline
cached slot checks and retain one allocation-free empty owner-cache sentinel so hot root, scope, and
stable owner-view reads avoid generic resolver and lazy-initialization overhead. Assign independent
dense cache slots for root, scope, and owner values so one lifetime cannot create holes in another's
arrays, and map descriptors directly to resolvers without retaining a second plan-level resolver
array.
