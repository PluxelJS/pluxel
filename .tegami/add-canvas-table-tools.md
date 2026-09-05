---
packages:
  '@pluxel/canvas':
    type: major
---

## Add bounded Canvas table tools

Add the plugin-free `@pluxel/canvas/table` entry for static data tables. It composes caller-provided,
bounded Pretext preparation with a caller-owned native context; it never allocates a surface, encodes
an output, fetches data, or owns a font/resource lifecycle.

Move pure Pretext layout, materialization, and walker exports from the Canvas root and worker text
entry to the single `@pluxel/canvas/pretext` path. The root remains the Canvas capability, while
`@pluxel/canvas/worker/pretext` only creates the bounded worker preparation adapter.
