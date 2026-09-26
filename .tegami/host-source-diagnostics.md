---
packages:
  '@pluxel/host-dev': patch
  '@pluxel/host': patch
---

## Report dynamic source failures with application updates

Publish dynamic discovery and missing-dependency recovery watcher errors through the same ordered
application update history used by candidate evaluation. Preserve running plugins and their individual
lifecycle history, and retain original errors in logs. Recovery hook failures are visible before a
candidate can start, without reporting an already recorded candidate failure twice.

## Recover initial dynamic entries and preserve execution attribution

Track separately evaluated dynamic roots even when the first candidate fails before a Host or catalog
exists. Syntax repairs retain unrelated service and Plugin generations; broad resolution retries are
reserved for missing imports. Snapshot source/built/unknown execution facts with each accepted catalog,
retain prior facts on rejection, and restore them when an application replacement needs compensation.
