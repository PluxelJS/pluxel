# Core logger contract

Core only owns author-facing logger identity and the `ContextLogger` facade.

- Runtime records: `pluxel.runtime.<rootId>`
- Plugin records: `pluxel.plugins.<rootId>.<entry-kind>.<entry-locator>.<root-export>.<instance>[.<fork-id>]`
- Plugin debug records carry the same structured node-address segments before topic segments.
- Runtime debug records: `pluxel.debug.<rootId>.runtime.<topic...>`

The Plugin category is a projection of `PluginNodeAddressSnapshot`; class name and `displayName` are
presentation only. Parsing reconstructs and validates the structured address, and policy/store filters accept
that address rather than a string Plugin identifier.

The runtime launcher owns LogTape installation, sinks, routing, dynamic plugin policy, persistence,
and shutdown. Its policy persistence contract is version 2: overrides are `{ owner, level }[]` records whose
`owner` is a validated `PluginNodeAddressSnapshot`. Plugins should use `ctx.logger` and
`ctx.logger.getDebugChannel(topic)` only.
