# Wretch 插件设计

`@pluxel/plugin-wretch` 只做一件事：让多个插件通过正常 required dependency 共享一个带宿主级 outbound policy
的原生 Wretch base。

## 为什么仍然是插件

普通 Wretch factory 没有生命周期或共享资源，不需要 Pluxel。这里值得成为 plugin 的部分只有进程级资源
上限和目标策略：所有 consumer 共用并发 admission、等待队列、attempt timeout 和 origin allowlist。这些
策略由 host 配置，并随 provider lifecycle 创建。

consumer endpoint、headers、auth、retry、dedupe、addon 和 response resolver 都不是 provider 所有。它们由
consumer 从 immutable base 派生，不注册 profile，也不复制 Wretch request/response API。

普通 client 与宿主策略不需要额外服务，`services: []` 仍可运行。受管设置是显式 opt-in；provider init 只捕获 Core 内建的 TinyBase owner handle，首次受管操作才恢复 provider node 唯一 Store。持久化目录、恢复与 IO 队列归 Host；provider generation 只拥有领域提交协调器和受管 dispatcher。

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

`WretchConfig` 从根入口导出，供 Host `envBinding`/`fileBinding` 复用同一声明；普通配置来源优先级由 Host 拥有。
caller 启用受管设置后，通过 `managedSettings`、`updateManagedSettings()` 和 `resetManagedSettings()` 完成无界面的读写；
Workbench target 只投影相同的快照、校验与持久化操作。保存 headers/proxy 属于 caller 状态，不能覆盖 provider 的 origin 或容量规则；
timeout 保存值在请求时始终取 host 上限与 caller 上限的较小值，旧保存值也不能放宽新的部署限制。

provider config 使用 Pluxel 标准 Config UI。consumer 可显式调用 `enableManagedSettings()`，再把
provider-owned `WretchWorkbench.settings` Attachment 放到自己的 placement。consumer 只绑定 direct
required dependency `{ provider: this.http }`；renderer、API factory 和 state 都由 provider 所有。

`WretchPlugin` 自己发布 Attachment factory。View 实际打开时，factory 只使用 Workbench 提供的
server-only `consumer.node` 查找已经由 `enableManagedSettings()` 建立的 exact state，然后返回 fresh
`WretchSettingsApi` target。target 同时受 consumer/provider generation、opened View signal 与 Cap’n Web
session ownership 约束。zero-props renderer 通过 descriptor-bound scope 的 query/mutation resources 取得 provider stub；
Framework 在结果进入 React state 前完成 portable 校验、原地冻结和顶层 ownership 释放。

managed settings 放在 Wretch provider node 的原生 Store `consumerSettings` 表。完整 caller `PluginNodeAddress` canonical bytes 的 SHA-256 是行 ID；每行保存 `version: 1`、完整 owner JSON 与 settings JSON，恢复时核对 owner 与行 ID。consumer 自己的业务 Store 不被占用，provider/fork 的持久隔离归 Host。

表内全部变更由一个领域协调器串行执行：校验输入、准备新 Dispatcher、原生 transaction 更新目标行、`await tinybase.flush()`、同步切换该 consumer 的 `current`/Dispatcher、关闭旧 Dispatcher。cached client 与页面只读取已应用状态；其他 consumer 的命令不能把未确认候选一起提交。reset 经过相同协调删除该 consumer 行并 flush，不删除 Store/backing。

保存失败保留原已应用状态、关闭候选 Dispatcher，并阻断该 provider Store 的后续提交；Host 的故障 writer 不在 autosave 或 shutdown 隐式重试候选。旧 Dispatcher 在提交后清理失败抛 `WretchSettingsCleanupError`（`code: 'SETTINGS_APPLIED_CLEANUP_FAILED'`、`applied: true`），新设置已经保存且生效。该清理错误不把已完成提交伪装为保存失败。

consumer stop 释放 dispatcher 和内存 state、保留行；replacement 从持久化行重新加载。同一 caller 的并发 `enableManagedSettings()` 共享一次初始化。opened target 同时绑定 caller/provider generation 与 View signal；stop、replacement 或 View close 后不能使用旧 capability。managed state 同时登记 caller cleanup 和 provider registry；显式非级联 provider restart 也会释放 ProxyAgent。

普通配置只接受非敏感 header 和无 credential 的 proxy URL。secret 不进入 browser contract 或普通
persistence。Attachment 不提供任意请求控制台；领域测试请求和响应脱敏仍归 consumer。

这里不改用 Content：设置属于 exact consumer，placement 也由 consumer 选择；动态 header collection、保存/reset 和
`ProxyAgent` replacement/cleanup 已经构成 provider-owned Attachment 的完整生命周期。provider Content 会丢失 consumer
所有权，consumer 自建 Content 又会复制 provider validation 和持久化。认证 secret 的 schema、刷新与轮换语义继续由
consumer 领域拥有，不并入这套普通设置。

## 有意不包含

- 通用 caller profile、公开 client generation API 或自定义 client handle；
- managed retry、自动 dedupe 或缓存；
- 请求指标、历史、response preview 或通用探针 DSL；
- Wretch addon/middleware 的包装 API；
- runtime internal hook。
