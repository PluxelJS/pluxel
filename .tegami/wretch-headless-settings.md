---
packages:
  '@pluxel/wretch': minor
---

# Headless Wretch deployment and managed settings

Export the existing WretchConfig schema and configuration types for Host env/file bindings. Expose caller-scoped managed settings reads, updates and resets without Workbench, preserving saved settings ownership and provider policy limits.

Allow ordinary HTTP clients and outbound policy to run without Persistence. Acquire storage only for explicitly enabled managed settings, and report missing Persistence instead of substituting transient storage.
