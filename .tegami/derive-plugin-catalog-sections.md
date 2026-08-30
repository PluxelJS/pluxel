---
packages:
  '@pluxel/runtime':
    type: major
  '@pluxel/runtime-dynamic':
    type: major
  '@pluxel/runtime-static':
    type: major
---

## Derive Plugin catalog sections from committed facts

Remove host-authored Plugin catalog classification and make headless Management a strict
`management: true` capability. Runtime now derives stable sections from provider declarations,
package-root identities, and source-entry parent directories, while persisting only user placement
and ordering preferences. Temporarily unavailable preferred sections fall back to the current derived
section without discarding the preference.

Replace the split Plugin list and group APIs with one revision-consistent catalog snapshot plus a
layout mutation, and advance the Management protocol to major 2. Old configuration shapes, wire
methods, DTOs, and preference versions are no longer accepted.
