# PackageHandle Design

## Goals
- Provide a stable package-manager RPC surface independent of market UI.
- Collapse the RPC surface into a single mutation entry point.
- Keep client usage consistent for single/batch operations.
- Preserve clear error semantics and fast batch behavior.

## API Shape
- `package().mutate(input)` accepts `{ action, specs, options }` and returns `PackageBatchMutationResult`.
- `package().loadIssues()` and `package().inventory()` remain as read-only queries.
- `market()` remains as a deprecated alias for compatibility.

## Behavior
- All mutations delegate to `applyMarketMutation` in `features/market/service.ts`.
- `action` decides the server-side flow (`install`, `uninstall`, `remove`, `reinstall`, `reload`, `retry`).
- `specs` can be a single item or a batch; `retry` with empty `specs` retries all known issues.

## Result Semantics
- `results` always contain per-spec outcomes when possible.
- `ok` is `false` when a batch error exists or any result failed.
- `error` is a batch-level failure message (e.g. invalid input, install failure).

## Performance Notes
- Install mutations batch package manager calls and load entries concurrently (bounded).
- Non-install actions keep service-level batching/locking for consistency.

## Decoupling Notes
- Market UI should be treated as a plugin-provided surface (extension point).
- Host RPC only owns package management capabilities and logs.
