---
packages:
  '@pluxel/rolldown': patch
---

# Verify Workbench transport in modules deployments

Validate capnweb declarations against real Workbench targets and record the verified version in
the generated deployment package manifest. Production Vite can admit compiled application targets
without requiring development dependencies in the deployment. Headless output and applications
without targets do not inherit source transport markers.
