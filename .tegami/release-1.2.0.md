---
packages:
  '@pluxel/async': minor
  '@pluxel/cli': minor
  '@pluxel/commands': minor
  '@pluxel/context': minor
  '@pluxel/core': minor
  '@pluxel/create': minor
  '@pluxel/host': minor
  '@pluxel/host-vite': minor
  '@pluxel/rolldown': minor
  '@pluxel/services': minor
  '@pluxel/test': minor
  valibot-form: minor
  '@pluxel/workbench': minor
  '@pluxel/plugin-auth': major
  '@pluxel/plugin-invoice': major
  '@pluxel/plugin-playwright': major
  '@pluxel/plugin-canvas': major
  '@pluxel/plugin-echarts': major
  '@pluxel/plugin-fonts': major
  '@pluxel/plugin-takumi': major
  '@pluxel/plugin-takumi-markdown': major
  '@pluxel/plugin-wretch': major
---

# Align the official Pluxel release line

Release the public framework packages and official Plugins together at 1.2.0. This is the maintainer's explicit version choice for the currently unpublished release; existing breaking-change descriptions remain part of the release notes. Future releases retain semver-based group bumps, and newly introduced pre-1.0 packages join the current release line.

Independent official Plugin packages use `@pluxel/plugin-*`. Update dependency names, package imports, subpath imports and application declarations together. This naming change preserves Plugin class names, exports and constructor declarations. Core, Host, Services, Workbench and tooling packages retain their existing names. Private Plugins remain workspace-only.

A Plugin's canonical identity includes its package entry. Rebuild consumer artifacts and explicitly review saved configuration, startup intent and Workbench state keyed by the previous identity before deployment; no old-name alias or automatic runtime migration is installed.

Carry forward the unpublished release notes. Earlier Host Dev notes belong to Host-vite; the former Typst Markdown extension belongs to the consolidated Markdown package. Their original explanatory bodies remain available alongside the later migration notes.
