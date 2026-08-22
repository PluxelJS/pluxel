# Core logger contract

Core only owns author-facing logger identity and the `ContextLogger` facade.

- Runtime records: `pluxel.runtime.<rootId>`
- Plugin records: `pluxel.plugins.<rootId>.<v1-node-route-segments...>`
- Plugin debug records carry the same structured node-address segments before topic segments.
- Runtime debug records: `pluxel.debug.<rootId>.runtime.<topic...>`

The Plugin category is a projection of `PluginNodeAddress`; class name and `displayName` are
presentation only. Parsing reconstructs and validates the structured address, and policy/store filters accept
that address rather than a string Plugin identifier. The route segments are readable and expose package/source,
root export, and fork when present. Immutable category projections are weakly cached after the first validation.

The runtime launcher owns LogTape installation, sinks, routing, dynamic plugin policy, persistence,
and shutdown. Its policy persistence writer is version 3: overrides are `{ owner, level }[]` records whose
`owner` is a validated `PluginNodeAddress`. Plugins should use `ctx.logger` and
`ctx.logger.getDebugChannel(topic)` only.
