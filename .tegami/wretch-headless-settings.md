---
packages:
  '@pluxel/plugin-wretch': minor
---

# Headless Wretch deployment and managed settings

Export the existing WretchConfig schema and configuration types for Host env/file bindings. Expose caller-scoped managed settings reads, updates and resets without Workbench, preserving saved settings ownership and provider policy limits.

Allow ordinary HTTP clients and outbound policy to run without Fs. Acquire storage only for explicitly enabled managed settings, and report missing Fs instead of substituting transient storage.
