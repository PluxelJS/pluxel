# Runtime

`@pluxel/runtime` 在 core 之上提供宿主无关的常驻能力；route package 选择插件来源和开发/部署方式。

## Runtime common

- HTTP plugin routes；
- config persistence、runtime state、persistence 和 plugin data；
- logger、events、effects 的 runtime wiring；
- admin access、vault 接缝和 web protocol；
- route-neutral catalog/status/config read models。

HTTP 是常驻能力，不依赖管理 UI。

## Route split

```text
@pluxel/runtime
  ├─ @pluxel/runtime-static  fixed catalog / definition reload
  └─ @pluxel/runtime-dynamic scan / loader / module replacement / HMR
```

runtime common 不依赖 dynamic。两条 route 只提供 catalog、source 和 replacement capability，不重新定义 plugin、DI 或 lifecycle。

## Optional host capabilities

Web Management 由 host launcher 根据一个顶层配置安装。启用时包含 UI registry、管理 RPC/SSE、management state、管理路由和 assets；关闭时整个 bundle 不初始化。

插件只使用 `ctx.webManagement.use()`。backend installation 和 required internal access 不属于作者 API。

Vault 同样由宿主注册和配置；插件只消费稳定 service surface。

## 实现入口

- `packages/runtime/src/runtime/`
- `packages/runtime/src/services/http/`
- `packages/runtime/src/services/web-management.ts`
- `packages/runtime/src/services/plugin-interaction/`
- `packages/runtime-static/src/internal/host.ts`
- `packages/runtime-dynamic/src/hmr/host.ts`

完整插件边界见 [`PLUGIN_SYSTEM.md`](PLUGIN_SYSTEM.md)。
