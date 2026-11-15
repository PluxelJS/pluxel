---
packages:
  '@pluxel/host': minor
  '@pluxel/services': major
---

# Preserve Plugin selection and uncertain batch outcomes

Script references retain the original address type and constructor or control
evidence in `address`, including when another run selects it. Source class
addresses provide dynamic configuration directly; generated addresses retain
their precise configuration types and union restrictions. Explicit parsing and
JSON delivery still produce plain identities.

Host implementation lists reject address values with a diagnostic that points
to policy/config selection. Source classes, generated providers and discovered
addresses use the same node identity in Host startup policy and configuration;
implementation loading remains with `plugins` and `sources`.

Management protocol major 12 reports a batch as `unknown` whenever any item has
an uncertain persistence outcome, preserving all individual results. Execution
and wire validation share one batch classifier. Upgrade management servers and
clients together.
