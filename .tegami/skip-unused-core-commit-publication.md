---
packages:
  '@pluxel/core':
    type: patch
---

## Skip unused host commit publication work

Avoid collecting and sorting generation publication facts when a Core host has no commit publication
consumer. Plugin lifecycle outcomes and commit summaries remain unchanged; hosts with preparation or
publication hooks retain their existing ordering and failure semantics.
