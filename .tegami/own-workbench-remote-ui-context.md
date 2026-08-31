---
packages:
  '@pluxel/auth':
    type: patch
  '@pluxel/fonts':
    type: patch
  '@pluxel/wretch':
    type: patch
---

## Make official Workbench remotes own their UI context

Wrap every official Mantine-based federated renderer in its own `MantineProvider` and synchronize the
provider with the portable Workbench color scheme. This keeps Fonts manager and selection attachments,
Auth setup, package management, and Wretch settings independent from the Shell's private React context
across React Bridge roots while the fixed Workbench MF profile reuses the Shell's Mantine modules and
base styles.
