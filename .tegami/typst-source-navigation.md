---
packages:
  '@pluxel/typst': minor
---

# Preview source navigation

Compiled previews now include page-local layout boxes, one-based UTF-16 source ranges and a heading outline from the exact document that produced Vector/PDF. Generated `/inputs/` resources are excluded from source jump targets. A pinned typst.ts native binding patch exposes these retained compiler spans without a second compilation or server. Building this private workspace package requires Git and Rust 1.97.1; platform artifacts are generated, never committed.
