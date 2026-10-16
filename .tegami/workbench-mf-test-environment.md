---
packages:
  '@pluxel/rolldown': patch
---

# Preserve Module Federation test environment controls

Workbench builds no longer change `MFE_VITE_NO_TEST_ENV_CHECK` implicitly. Test harnesses that build real federation artifacts opt in explicitly with the upstream `MFE_VITE_NO_TEST_ENV_CHECK=true` setting.
