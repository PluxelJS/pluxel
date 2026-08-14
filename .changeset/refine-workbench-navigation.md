---
'@pluxel/runtime': major
---

Group shell-only Workbench navigation under the nullable `host.navigation` capability so standalone
Views can detect that `navigate()` and `openTab()` are unavailable instead of receiving methods that
only fail when called. Refine native Tab identity, document deduplication, navigation reconciliation,
and persisted workspace-state migration around concrete Tab instances.
