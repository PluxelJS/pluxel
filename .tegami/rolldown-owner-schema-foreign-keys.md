---
packages:
  '@pluxel/rolldown': patch
---

# Resolve generated plugin foreign keys within the owner schema

New Drizzle migrations keep foreign keys between ordinary `pgTable()` tables in the plugin's isolated owner schema. Explicitly scoped and external references retain their declared schema.
