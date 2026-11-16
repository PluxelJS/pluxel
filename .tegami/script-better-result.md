---
packages:
  '@pluxel/host': major
  '@pluxel/host-vite': major
  '@pluxel/rolldown': major
  '@pluxel/services': major
  '@pluxel/cli': patch
---

# Preserve native business Result values at the script return boundary

Script SDK controls use ordinary `await`, return successful values directly, and
throw `ScriptError` on expected failures. Configuration, policy, and log results
are projected once without a redundant success flag; failures preserve revisions,
persistence uncertainty, validation details and complete reports. Recover only
where the task needs to handle a failure. Plugin business methods retain their
own return types and errors, including native Better Result.

`plugin().instance()` returns `{ instance }` from the committed read. This protects
Plugins with a business `then` member and preserves original method signatures,
receiver behavior, results, and exceptions.

The script return boundary encodes actual shared Ok/Err instances through the
native Result codec. Plain JSON results remain plain JSON. Domain Err results
remain successfully completed script runs; cancellation and execution defects
retain their original execution state. Payloads retain strict JSON validation
and complete-envelope budgets, with no implicit class or `toJSON` conversion.
Uploaded factories bind that canonical import to the receiver's shared namespace;
direct or indirect copies of the Better Result runtime are rejected.

# Use one Plugin selector in Vite and uploaded scripts

Select `sdk.plugin(Provider.nodeAddress())` or `Provider.nodeAddress(id)` for a
fork. The same SDK checks current source implementation identity in committed
reads and lifecycle sessions; cached source references fail explicitly after
HMR replaces their implementation. Source classes retain instance types;
generated providers also supply precise Schema input/output types. Native
Context access uses the common `sdk.ctx` property.

Real project scripts, installed consumers, browser validation callers, templates,
CLI-generated instructions, and public guidance use this same contract.
