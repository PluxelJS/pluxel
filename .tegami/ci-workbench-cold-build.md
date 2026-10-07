---
packages:
  '@pluxel/core': patch
  '@pluxel/workbench': patch
  '@pluxel/rolldown': patch
---

# Build production Workbench artifacts from the source package graph

Compile Plugin and application Workbench producers with explicit source exports and production conditions, including shared export inspection and required dynamic types. Cold workspace builds no longer require prebuilt Workbench artifacts. Distribution assembly continues to require built package exports without falling back to source.

Update the Oxc parser dependency to 0.153 and validate the build with the refreshed Vite, Rolldown, and TypeScript toolchain.

Bundle the Workbench-owned pure transport admission rules into the toolchain and locate its capnweb dependency through the package manifest. Publication metadata validation no longer loads the Workbench runtime build.

Update the exact Workbench federation compatibility profile to Module Federation Vite 1.23.3 and Runtime, SDK, and React Bridge 2.9.2. Rebuild producer artifacts with the updated profile. Keep the full shared export surface adaptation for Mantine producers.
