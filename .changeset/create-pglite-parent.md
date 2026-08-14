---
'@pluxel/runtime': patch
---

Create the parent directory for the default PGlite database path so a plugin can acquire its
database when the configured persistence root does not exist yet.
