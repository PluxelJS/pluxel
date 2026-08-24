---
packages:
  '@pluxel/core':
    type: major
  '@pluxel/rolldown':
    type: major
  '@pluxel/runtime':
    type: major
---

## Prefer proxy-free owner and caller views

Keep Context capability access, HTTP owner views, Plugin dependency caller facades, named event
channels, config snapshots, and SSE namespace clients on ordinary objects and precompiled property
descriptors. HTTP now separates its single root backend from small owner views while preserving
owner-effects route cleanup and existing `ctx.http` usage. The host HTTP mount API now rejects
non-root owner views, preventing accidental host mounts from bypassing `ctx.http.plugin` cleanup;
the root Context remains host authority rather than an adversarial Plugin sandbox.
Core and Runtime service views pin `ctx` as a non-writable ordinary property so cached handles
cannot be rebound to another cleanup owner.

`EvtChannel` now accepts a direct Context only; caller subscription ownership is projected by Core
instead of being implied by `() => this.ctx`, including `onAt()`, `onFront()` and delayed
`when()` registrations. Plugin dependency surfaces are fixed after construction, so type-only
declared fields now fail with `plugin_caller_view_declared_field_unsupported`. Raw config reads
return immutable, revision-bound snapshots rather than live Proxy views. Config snapshots reject
accessors, hidden properties, symbol keys and non-JSON primitive values without executing user
getters. The `configs.use()` initialization sentinel is now a frozen identity token; the toolchain
remains the authority that rejects early config reads.

The browser Cap'n Web client's type-erased dynamic RPC method stub keeps its Proxy-based transport
adapter; it does not participate in backend Context, ownership, effects, or lifecycle projection.
