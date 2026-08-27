# @pluxel/runtime-node

`@pluxel/runtime-node` 是 Pluxel 内部的 Node platform carrier package。它把 runtime-common 的 Fetch dispatcher 和原生 Elysia 2
application directory 接到 srvx Node listener，并用 crossws 承载业务 WebSocket。Plugin 作者不直接依赖或配置这个 package；作者面始终是
generation-scoped `ctx.elysia`。

## 当前职责

- 把 srvx `Request` metadata 保留到 Elysia handler，支持 carrier-backed `server.requestIP(request)`；
- 连接 Elysia 2 global WebSocket handler 与 crossws 的 Node upgrade；
- dispatch 基础 `open`、`message`、`close`、ping/pong event，并转发 send；
- 将 pub/sub topic 限定到 immutable owner key；
- owner replacement 时发送 `1012 Service Restart`，有界等待 close 后强制终止并精确释放 lease；
- 为 Vite 提供业务 upgrade matcher/handler；Vite HMR protocol 和 path 由 Vite carrier 先行仲裁。

生产 Node launcher、static Vite 和 dynamic Vite 复用这一份实现，避免各自复制 srvx/crossws glue。runtime-common 仍不导入 `node:*`、srvx
或 crossws。

## 已验证范围

真实 ephemeral listener 测试覆盖基础 HTTP body round-trip、client disconnect、stream cancellation、Elysia `.use(websocket()).ws()`、
基础 open/message/close、两个独立 owner、owner-scoped pub/sub、replacement `1012` drain，以及 transport 不回报 close 时的强制 settlement。

这不代表完整的跨 runtime Elysia Server parity：

- `host.fetch()` 是 Fetch dispatcher 测试入口，不执行真实 WebSocket upgrade；
- 尚无第二个 Bun、Deno 或 Worker carrier conformance；
- crossws 没有可移植的主动 `pong()`，send/backpressure 返回语义也未与所有 runtime 精确对齐；
- application-level WebSocket payload、compression、idle timeout 等 tuning 尚未完整投影到共享 carrier；
- Elysia 2 beta.7 没有公开 external application attach/detach epoch，因此 generation app 的 `setup()` / `cleanup()` fail-fast；
- Plugin app 的 `listen()` / `stop()` 同样 fail-fast，因为物理 listener 生命周期属于 launcher。

## Elysia singleton policy

发布的 Plugin package 若直接 import `elysia` 或 `elysia/websocket`，必须把 Runtime 支持的精确 Elysia 版本同时放在
`peerDependencies` 与 `devDependencies`。peer 让宿主提供唯一 runtime copy，dev dependency 供 package 自身编译与测试。当前版本是
`2.0.0-beta.7`；不要把 Elysia bundle 进 Plugin，也不要用宽范围意外安装第二份 instance。这是当前 beta 的 package 发布政策；
Runtime 已统一 static/dynamic singleton identity，但尚未在共同 catalog admission 中读取并强制校验 Plugin manifest 的 peer range。
