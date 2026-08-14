# Core logger contract

Core only owns author-facing logger identity and the `ContextLogger` facade.

- Runtime records: `pluxel.runtime.<rootId>`
- Plugin records: `pluxel.plugins.<rootId>.<pluginId>`
- Debug records: `pluxel.debug.<rootId>.<origin>...<topic>`

The runtime launcher owns LogTape installation, sinks, routing, dynamic plugin policy, persistence,
and shutdown. Plugins should use `ctx.logger` and `ctx.logger.getDebugChannel(topic)` only.
