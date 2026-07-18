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

## Workbench

provider config 使用 Pluxel 标准 Config UI。consumer 可显式调用 `enableManagedSettings()`，再通过
`WretchWorkbenchPort` 选择自己的 placement。provider 提供统一 renderer；consumer 只提供 caller-bound RPC
grant，不重复实现 headers/proxy/timeout 表单。

managed settings 以 caller plugin ID 写入 provider persistence namespace，并保留一个 caller Context state。
cached client 的 deferred callback 每次请求重新解析 state，所以先创建 client、后启用或保存设置都会立即生效。consumer stop 会释放
proxy dispatcher 和内存 state；replacement 从 persistence 重新加载。

普通配置只接受非敏感 header 和无 credential 的 proxy URL。secret 不进入 browser contract 或普通
persistence。Port 不提供任意请求控制台；领域测试请求和响应脱敏仍归 consumer。

## 有意不包含

- 通用 caller profile、client generation 或自定义 client handle；
- managed retry、自动 dedupe 或缓存；
- 请求指标、历史、response preview 或通用探针 DSL；
- Wretch addon/middleware 的包装 API；
- runtime internal hook。
