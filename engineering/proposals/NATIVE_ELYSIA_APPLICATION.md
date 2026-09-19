# Elysia 外部承载：尚待验证的边界

本文只记录尚未完成的上游能力与验证工作，不定义当前作者 API。已经落地的架构以
[Host](../HOST.md)、[Plugin 系统](../PLUGIN_SYSTEM.md) 和
[HTTP 使用文档](../../docs/runtime/http.md) 为准。

目前已验证 Node carrier 与 Vite 开发接入。Elysia singleton identity、generation 所有权、HTTP/stream/WebSocket
回收和精确声明冲突已有实现与回归；它们并不意味着以下问题已经解决。

## 未决工作与完成标准

| 缺口                       | 当前边界                                                                                      | 完成标准                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 第二个真实 carrier         | Node 已验证；Bun、Deno 尚无等价证明                                                           | 至少一个 Bun 或 Deno carrier 与 Node 共用 HTTP、stream、WebSocket 和生命周期 conformance suite          |
| 等价路由冲突               | 能拒绝跨 owner 的相同 kind、method、declared path；不能证明 matcher-equivalent pattern 无冲突 | Elysia 提供公开的 compiled matcher signature，并通过参数改名、可选片段、trailing slash 等冲突测试       |
| Plugin 包版本准入          | singleton identity 不等于 `elysia` peer range 兼容                                            | 封存包的兼容声明，static/dynamic 使用同一 admission contract，缺失、不可解析、不兼容 range 均有明确诊断 |
| 外部 application lifecycle | 缺少公开 attach/detach epoch；直接使用 `setup()` / `cleanup()` fail-fast                      | 上游公开 epoch 可支持成功、失败回滚、请求排空与 exactly-once detach，且不访问私有 callback              |
| 更广插件兼容性与性能       | 当前覆盖不能代表所有官方插件、server-specific capability 或平台组合                           | 建立明确的兼容矩阵，用相同 workload 测量真实场景，再决定是否优化 dispatcher                             |

## Carrier 验证约束

第二个 carrier 必须复用现有 contribution、dispatcher 与生命周期实现，差异限定在网络平台接入。
验证至少包括：

- HTTP 请求、错误与响应语义，以及请求中止和客户端断开。
- streaming response 在正常结束、取消、owner 停止和 HMR 时的排空或终止。
- WebSocket upgrade、消息、连接关闭，以及旧 generation 退出后的连接所有权。
- init 失败、贡献撤回、宿主关闭与在途请求之间的时序。

Fetch 类型兼容不能代替真实网络验证。不得复制一套 Bun/Deno 业务 dispatcher 来绕过公共 carrier contract 的缺陷。
生产 Node 与 Vite upgrade 都应保留实际 socket 回归。

## 路由与上游 lifecycle

Pluxel 不复制 Elysia route grammar，不读取私有 matcher 或 `~ext` callback。
上游尚未提供 public seam 时，继续明确报告当前限制，不通过推测制造兼容性承诺。

matcher signature 到位后，应同时验证冲突诊断的 owner、route 和候选更新信息，以及拒绝候选时的旧发布保留。
外部 lifecycle epoch 到位后，必须覆盖 setup success/failure、late cleanup registration、rollback、drain
与 exactly-once detach。通过 `.use()` 间接带入的 application lifecycle 也需要明确检测与支持边界。

## 包版本准入

包构建或加载计划应读取 owning package 的 `elysia` peer range，将规范化声明封存到可信 metadata；
static 与 dynamic 随后使用同一公开准入规则，在 lifecycle 与 publication 之前与宿主 contract 比对。
Core 不扫描文件系统，也不依赖 package manager 布局。

构建/freezer 可以在模块求值之前验证包 metadata；任意 constructor source 可能已经求值，不能承诺通用的
pre-evaluation rejection。应用内源码由应用 lockfile 控制，与发布 Plugin 包的 peer contract 区分。

验证必须覆盖缺失 peer、非法 range、不兼容 range、兼容 range、多份 Elysia identity 以及 static/dynamic 诊断一致性。
只有这一整条链路落实后，才能声称完成包版本准入。

## 兼容矩阵与性能证据

记录已验证的 Elysia 版本、插件版本、carrier 与具体 capability。对依赖 server-specific 行为的插件，验证真实
carrier 行为；对未覆盖组合保持未知状态。

基准应比较相同路由、payload、hook、stream/WebSocket workload，并记录延迟、吞吐、资源消耗和 generation
切换成本。只有证据显示 dispatch 成为瓶颈，且上游存在稳定公开 seam 时，才考虑调整路由发布路径；不得牺牲
owner 隔离和撤回语义换取未经验证的优化。
