---
packages:
  '@pluxel/core':
    type: patch
  '@pluxel/runtime':
    type: major
  '@pluxel/runtime-dynamic':
    type: major
  '@pluxel/runtime-static':
    type: major
  '@pluxel/create':
    type: minor
---

## Use generation-scoped native Elysia 2 applications

Replace the Plugin-specific `ctx.http.plugin.routes()` / `mount()` publication layer with the
upstream Elysia 2 application available at `ctx.elysia`. Route paths are now final product paths:
Pluxel no longer generates a Plugin namespace or accepts `publicPath`, mount ids, application option
bags, route handles, or `replaceRoutes()`. Reusable APIs can be ordinary Elysia function plugins,
and existing Fetch applications can use Elysia's native `mount()`.

Each Plugin generation and all of its Parts share one lazy Elysia instance. Runtime waits for lazy
modules, validates the public route inventory, uses Elysia's native compile/seal boundary, settles
cross-owner contributions, prepares an immutable dispatcher, and atomically publishes it with the
Core running projection. Removal and replacement withdraw the old contribution; entered streaming
responses remain tied to the owner generation until their bodies settle.

Cross-owner conflict admission currently rejects only routes with the same route kind, declared
method, and declared path. Matcher-equivalent parameter or optional patterns are not canonicalized
by Pluxel; Elysia remains the route-grammar authority.

Runtime test hosts now expose `host.fetch(request)` as the host carrier boundary. Migrate tests away
from `host.ctx.http.fetch(...)`. Runtime no longer exports `createElysiaApp`, `ElysiaRouteHandle`,
`PLUGIN_HTTP_BASE`, or Plugin Fetch-boundary types.

Static and dynamic hosts adopt the same native-application directory and host Fetch boundary. The
static Node launcher uses srvx for the platform Request/Response carrier instead of maintaining a
separate hand-written Node conversion path.

The Node carrier also connects Elysia 2 WebSockets through public Elysia and crossws APIs. It keeps
topics and connection drain owner-scoped, closes only a replaced/stopped owner's sockets with 1012,
and exposes carrier-backed server metadata and request IP. Node-backed Vite integration attaches the
same business dispatcher and WebSocket bridge without taking ownership of Vite's HMR upgrade path.

Elysia 2 beta.7 does not expose a public external application attach/detach lifecycle epoch, so
Plugin application `setup()` and `cleanup()` calls fail immediately instead of reading private
Elysia callback state. Physical `listen()`/`stop()` and server stop/reload controls also remain
host-owned and fail fast. A Bun/Deno second carrier, cross-runtime portable WebSocket conformance,
canonical-equivalent route collision detection, and Plugin Elysia peer-range admission are not part
of this release's completed baseline.

The starter now generates direct Elysia 2 route composition and uses the matching Elysia 2
dependency. Existing projects should declare their final route prefix with Elysia `group()` or full
paths instead of a Pluxel `publicPath` option.

Core adds package-internal generation-finalization, settlement, commit-preparation, and synchronous
publication hooks so Runtime can integrate application lifecycle without exposing HTTP concepts or a
second lifecycle API to Plugin authors.
