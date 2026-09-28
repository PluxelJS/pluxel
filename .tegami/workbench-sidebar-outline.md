---
packages:
  '@pluxel/workbench':
    type: patch
---

## Improve Workbench sidebar scrolling and document navigation

The built-in Workbench overview scrolls independently with fixed tabs. Configuration and Markdown headings appear in a separate searchable outline tab even when the editor does not overflow. Outline tracking scrolls only its own list, uses the available sidebar height, and follows the active editor. Sidebar tab switches retain mounted scroll positions.
