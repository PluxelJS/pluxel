# 受管出站 HTTP

Core 通过 `PluginContext.wretch` 提供原生 Wretch，通过 `PluginContext.fetch` 提供标准 Fetch 调用签名。Wretch 基础实例按运行代惰性取得，绑定同一个 Fetch。插件负责目标 API 的认证、请求构造、重试和响应校验。 [插件用法](../docs/plugin-development/outbound-http.md) · [Context 设施边界](CORE.md#context-service-kernel)

## 归属与接纳

受管 Host 共享一份出站运行时和队列。请求归取得传输句柄的节点及运行代。Part 共用所属运行代，跨插件调用中 B 使用自己的 Context 发送的请求归 B。停止、替换或关闭通过既有 owner admission 撤回句柄并取消在途请求。原生响应体由调用方读取或取消，运行代和 Host 的取消信号继续关联响应流。`managed: false` 的宿主使用相同的生命周期边界，直接调用平台或部署提供的 Fetch。客户端首次请求时绑定运行代信号，第一个参数与调用方原输入相同。 [能力寿命](PROVIDER_WITHDRAWAL_AUDIT.md)

受管传输先校验绝对 HTTP(S) URL，再按已应用策略判定。排队期间策略可能变化，出队时按变化后的策略重新判定。并发占位与单次超时从接纳开始，到 Fetch 返回响应头或失败结束。两入口共用同一阈值，Wretch 的每次重试重新接纳。部署可通过 `coreConfig.http.fetch` 注入最终传输。受管模式的注入传输接收已应用策略的 `Request`，遵守它的取消信号，并转交 Node 代理使用的每请求 Dispatcher。测试宿主使用同一契约。 [接纳与传输](../packages/core/src/http/runtime.ts)

部署、宿主管理默认和节点规则的 origin 约束取交集。省略该层即继承，显式空数组拒绝该范围的受管请求。启用任何 origin 限制时，URL 或字符串输入省略 `redirect` 采用 `error`。已有 `Request` 按 `init` 覆盖其原有值。最终为 `follow` 的请求在传输前被拒绝，`manual` 采用平台原生响应。`error` 在传输层用 `manual` 发一跳，遇到重定向即取消响应体并以 `TypeError` 失败，兼容只接纳 `follow` 和 `manual` 的 workerd。调用方通过受管 Fetch 显式发下一跳时再次进入同一判定。 [Fetch 重定向](https://fetch.spec.whatwg.org/#http-fetch) · [Workers Request](https://developers.cloudflare.com/workers/runtime-apis/request/)

可用配额走同步接纳路径。并发配额用满时，占用最后一个配额的调用发布容量变化的 Promise，后续调用按先进先出等待前序事件的完成。取消从队列移除当前调用并唤醒其后继。在 workerd 中由仍持有 I/O 的事件创建等待信号，等待方可在自己的事件上下文继续发送。 [出站接纳](../packages/core/src/http/admission.ts) · [跨事件回归](../packages/host/tests/cloudflare/runtime.test.ts)

策略拒绝以核心的 `OutboundHttpError.code` 表达。队列容量、origin、重定向模式和 Dispatcher 冲突都有独立分类。HTTP 状态和传输异常保留上游语义，Wretch 按自己的协议处理 Fetch 结果。请求显式设置的头优先，受管节点默认值与宿主默认值依次补缺。 [配置](../docs/host/configuration.md#受管出站-http) · [输入校验](../packages/core/src/http/options.ts)

## 保存与资源

出站运行时从 `services/host/outbound-http/policy.json` 惰性恢复 Host 默认和节点覆盖。节点按完整 `PluginNodeAddress` 保存。首次管理读取与首次发送共享恢复结果。插件停止和 HMR 保留设置，显式删除 fork 时由 Host 节点事务清理覆盖与活动摘要。 [Host 文档](FS.md#host-文档与关闭) · [fork 清理](../packages/host/src/forks.ts)

通过 revision 校验候选，准备代理后等待文档提交，随后发布同一份生效快照。并发编辑使用读到的 revision，过期提交报告冲突。文档写入结果无法确认时，保留已生效快照，释放候选资源并暂停后续写入。核对文档后在新 Host 恢复。代理替换后，新请求采用新快照，旧 Dispatcher 排空已接纳的请求后关闭。Management 在应用结果发布后退出 Host 的写入门控，再等待旧资源清理。清理失败在已应用回执中单独报告。 [运行时](../packages/core/src/http/runtime.ts) · [管理投影](../packages/services/src/management/services/management/RuntimeManagementTarget.ts)

Node 装配提供原生 Undici ProxyAgent 工厂，根运行时惰性创建并关闭代理资源。工厂按内置 Undici 的协议选择匹配的每请求 Dispatcher。浏览器和 Cloudflare 请求入口保持平台 Fetch。部署可以锁定代理，保存的覆盖此时仍可读取或清除，生效值采用部署配置。管理回执确认配置已应用，代理连通性来自实际请求。 [Node 代理工厂](../packages/core/src/http/node-proxy.ts) · [Undici Dispatcher 兼容](https://github.com/nodejs/undici/blob/v8.12.3/README.md#undicisetglobaldispatcherdispatcher)

## 管理与观测

Workbench 通过已有认证的 Management 会话读取出站活动。总览跟随联网日志流，有新记录时重新读取 Host 的节点摘要。节点覆盖在插件详情的出站设置中编辑，来回跳转保留精确节点筛选。宿主与节点共用规则编辑器，各字段旁显示宿主返回的生效值。Headless 使用同一运行时和保存输入。 [Workbench 操作](../docs/workbench/operations.md#查看受管出站-http)

受管模式的 `records` 由宿主创建时确定。`summary` 按节点保留当前实例内的最近结果和计数。`requests` 同时向 `pluxel:outbound-http` 写入已结算的尝试，保留最近 5,000 条。每条包含 canonical 节点地址、方法、origin、耗时和结果。URL 路径、查询、请求头和正文留在请求本身。`off` 跳过观测计时、节点计数和日志对象构造。日志流独立于插件调试级别和 LogTape 配置。同进程插件的全网络强制控制需要按插件身份隔离的执行环境和网络出口策略。 [日志存储](LOGGING.md#runtime-store)

Workbench 初次读取从宿主取最近匹配的记录。省略日志 range 的 `fromSeq` 时，存储从尾部用分块索引筛选，仍按序号升序交付。达到 RPC 字节预算后按已有游标续读。实时订阅合并队列中连续的 append，复用入队时的字节计数，保留有界队列和缺口恢复。

回归入口包括 Core 的公开 Context 消费、排队策略变更、停止、保存、原生 Node 代理交接，以及 Services 的授权管理和独立安装测试。 [Core 回归](../packages/core/tests/plugins/OutboundHttp.test.ts) · [交付消费者](../packages/services/tests/installed/services.smoke.mjs)

## Cloudflare Worker Host

- **Host 启动。** `@pluxel/host/cloudflare` 使用根内存文档，运行时闭包无需 ZenFS。真实 workerd 回归从 handler 启动正常 lowering 的 provider/consumer 图，再执行受管 Fetch，并核对连续和并发请求的隔离及关闭。 [Worker Host 回归](../packages/host/tests/cloudflare/runtime.test.ts) · [Host 入口](../docs/host/configuration.md#cloudflare-worker-host)
- **出站传输。** 公网使用平台 Fetch。部署通过 `coreConfig.http.fetch` 在当前事件中获取并调用 Service Binding，origin 规则采用绑定对应的逻辑 URL。HTTP 层按上面的单跳契约处理 workerd 的 `redirect: 'error'`。 [Service Binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/) · [Workers Request](https://developers.cloudflare.com/workers/runtime-apis/request/)
- **请求生存期与观测。** 调用方将当前 `request.signal` 传入插件方法，并在事件内结算该调用的作用域。记录和生效策略保留在当前 Host 的内存。联测覆盖已取消的调用信号，真实客户端断连时入站 signal 的行为仍需在部署所用的传输上验收。 [Workers 请求作用域](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) · [Workers 取消信号](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)
