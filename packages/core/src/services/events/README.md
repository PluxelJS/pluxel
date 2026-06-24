# Events

Pluxel has one events service.

- Public/plugin events use `ctx.on()` / `ctx.emit()`.
- Internal runtime signals use `ctx.internalEvent`.

Current internal channels:

- `ctx.internalEvent.runtimeCommitted`
- `ctx.internalEvent.resolverCacheInvalidated`
