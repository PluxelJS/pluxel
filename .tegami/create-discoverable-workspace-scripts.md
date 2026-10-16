---
packages:
  '@pluxel/create': patch
  '@pluxel/cli': patch
---

# Restore discoverable workspace scripts

Expose development, build, test, check, fix, and verification scripts in generated workspaces so IDEs can discover them. Aggregate scripts delegate to native Vite tasks while underlying build and test tasks retain their caching policies.

Keep mise focused on tool versions and environment settings in both application and plugin templates. Project operations live in package scripts; managed application development directly starts Pitchfork, which runs the app’s dev:server entry. Install dependencies with vp install before running workspace setup.
