---
packages:
  '@pluxel/plugin-takumi-markdown': patch
---

# Keep the workspace-only Typst integration optional when packing Markdown

Use an optional unversioned peer and a local development link for the private Typst provider. pnpm can now pack the public Markdown plugin without resolving a nonexistent Typst release version. Ordinary Markdown still works without Typst, and source workspaces retain the same optional mathematics integration. No Plugin API or provider installation behavior changes.
