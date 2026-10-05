---
packages:
  '@pluxel/rolldown': patch
---

# Resolve package imports in modules delivery

Resolve package.json imports during modules builds: compile local targets and retain external package boundaries. Relocated outputs no longer contain unresolved package-local aliases whose mappings were omitted from the output manifest.
