---
packages:
  '@pluxel/rolldown': patch
---

## Reuse exact source parses across transform stages

Keep original and transformed module parses in the same bounded cache instead of evicting each
other. Reuse imported PluginPart analysis within one resolution operation. Reject standalone OXC
recovery ASTs with syntax errors so malformed source cannot produce accepted lowering facts.
