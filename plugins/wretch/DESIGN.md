# Wretch 插件设计

`@pluxel/wretch` 只做一件事：让多个插件通过正常 required dependency 共享一个带宿主级 outbound policy
的原生 Wretch base。

## 为什么仍然是插件

普通 Wretch factory 没有生命周期或共享资源，不需要 Pluxel。这里值得成为 plugin 的部分只有进程级资源
上限和目标策略：所有 consumer 共用并发 admission、等待队列、attempt timeout 和 origin allowlist。这些
策略由 host 配置，并随 provider lifecycle 创建。

consumer endpoint、headers、auth、retry、dedupe、addon 和 response resolver 都不是 provider 所有。它们由
consumer 从 immutable base 派生，不注册 profile，也不复制 Wretch request/response API。

## Wretch 组合顺序

`client` getter 为 caller 创建原生 base，并在请求发送前解析当前 caller settings：

```text
wretch()
  -> defer(client => client.middlewares([hostPolicy]))
```

Wretch 在请求发送前才执行 `defer()`。这让 consumer 后加的 retry 等 middleware 保持在 host policy 外层：

```text
consumer retry/dedupe
  -> host origin + admission + timeout
  -> consumer fetchPolyfill/global fetch
```

每个 retry attempt 独立 admission 和 timeout。`fetchPolyfill()` 保持可用；provider 不包一层新的 client、
response 或 error 类型。

`client` 仍是原生 Wretch object，但创建时会绑定 caller 与 provider 当前 lifecycle generation。caller 或
provider stop/replacement 后，缓存的旧 client 不再接受新 attempt；等待 admission 的 attempt 会立即拒绝，
已经进入 fetch 的 attempt 会收到同一个 lifecycle abort signal。自定义 fetch 是否能立即结束仍取决于它是否遵守
标准 `AbortSignal`。policy cleanup 通过 provider effects 登记，和正常 stop、replacement、rollback 共用一条路径。

## Workbench

provider config 使用 Pluxel 标准 Config UI。consumer 可显式调用 `enableManagedSettings()`，再把
provider-owned `WretchWorkbench.settings` Attachment 放到自己的 placement。consumer 只绑定 direct
required dependency `{ provider: this.http }`；renderer、API factory 和 state 都由 provider 所有。

`WretchPlugin` 自己发布 Attachment factory。View 实际打开时，factory 只使用 Workbench 提供的
server-only `consumer.node` 查找已经由 `enableManagedSettings()` 建立的 exact state，然后返回 fresh
`WretchSettingsApi` target。target 同时受 consumer/provider generation、opened View signal 与 Cap’n Web
session ownership 约束。renderer 是 zero-props component，通过
`useWorkbench(WretchWorkbench.settings)` 取得 provider stub；所有 object RPC result 在读取后释放顶层
ownership。

managed settings 以 caller `PluginNodeAddress` canonical bytes 的完整 SHA-256 作为物理文件名，并保留一个 caller Context state。
文件 envelope 同时保存完整结构化 owner，加载时严格比对；display name 相同的 Plugin/fork 不会冲突。只读取
`consumers/v3` 下的当前 v2 envelope，其他版本直接拒绝。
cached client 的 deferred callback 每次请求重新解析 state，所以先创建 client、后启用或保存设置都会立即生效。consumer stop 会释放
proxy dispatcher 和内存 state；replacement 从 persistence 重新加载。同一 caller 的并发
`enableManagedSettings()` 共享一次初始化，不会重复读取 persistence 或创建 proxy dispatcher。opened settings target
同样绑定 caller/provider generation 与 View signal，stop、replacement 或 View close 后不能继续读写旧 state。managed state 同时登记 caller
cleanup 和 provider-owned registry；即使宿主显式执行非级联 provider restart，ProxyAgent 也会由 provider effects 释放。

普通配置只接受非敏感 header 和无 credential 的 proxy URL。secret 不进入 browser contract 或普通
persistence。Attachment 不提供任意请求控制台；领域测试请求和响应脱敏仍归 consumer。

## 有意不包含

- 通用 caller profile、公开 client generation API 或自定义 client handle；
- managed retry、自动 dedupe 或缓存；
- 请求指标、历史、response preview 或通用探针 DSL；
- Wretch addon/middleware 的包装 API；
- runtime internal hook。
