---
packages:
  '@pluxel/host-dev': major
---

## Keep candidate orchestration inside the development host

Stop exporting candidate creation, invalidation, source evaluation and recovery implementation helpers
from `/vite`. Custom service attachments use `HostDevelopmentPluginApi`; the Host remains responsible
for admitting, committing and settling candidates.
