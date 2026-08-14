---
'@pluxel/runtime': minor
---

Allow plugins to mount lifecycle-owned business HTTP boundaries at stable runtime-root paths with
`ctx.http.plugin.routes(..., { publicPath })`, while reserving the runtime control-plane namespace
and rejecting ambiguous path ownership.
