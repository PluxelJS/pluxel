---
packages:
  '@pluxel/rolldown': minor
---

## Locate Plugin configuration in a selected application

Extend `project.plugin()` with an explicit `application` context and an `inputs` section for config
environment/file bindings, schema references, and the application `configRecords` expression. Support
targeted source-entry Plugins using the compiler's source-space identity rules. Application queries
resolve actual package sources from the selected entry rather than substituting workspace packages.

Share declaration facts between build transforms and inspection without evaluating application or
schema factories. Preserve actionable source locations for analysis gaps and propagate exhausted
read budgets as query failures. Existing workspace discovery and file ownership scopes stay unchanged.
