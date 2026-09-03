---
packages:
  '@pluxel/core':
    type: major
  '@pluxel/runtime':
    type: major
  '@pluxel/test':
    type: major
  '@pluxel/runtime-static':
    type: major
  '@pluxel/runtime-dynamic':
    type: major
  '@pluxel/create':
    type: patch
---

## Make Plugin tests follow production boundaries

Replace the shared staged test host with explicit Core, Runtime, static-application, and dynamic-runtime
test boundaries. Common lifecycle operations now commit immediately, multi-change fixtures use one
synchronous callback-scoped commit, expected lifecycle failures return a slot-free structured summary,
and hosts and leases expose deterministic disposal contracts.

Move Core graph tests to `@pluxel/core/test`, Runtime capability tests to `@pluxel/runtime/test`, static
application wiring tests to `@pluxel/runtime-static/test`, and dynamic carrier tests to the production
`@pluxel/runtime-dynamic` launcher. Remove the `@pluxel/test` root entry and keep only its explicit Vitest,
fixture, and unsafe-lowering subpaths. The Vitest preset now registers one identity-aware
`toHavePluginLifecycleIssue()` matcher with constructor and fork support and redacted failure diagnostics.

Update official Plugin tests, projects, generated templates, package guides, and user documentation to use
the new boundaries without compatibility aliases.
