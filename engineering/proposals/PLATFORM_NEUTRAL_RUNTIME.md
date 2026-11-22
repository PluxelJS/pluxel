# 跨平台 Host 的后续能力

Node、浏览器和 Cloudflare 共用的应用声明、根与事件作用域、插件替换及关闭行为分别由 [Host 架构](../HOST.md#应用工厂与运行寿命) 和 [HMR](../HMR.md#浏览器-worker-与-cloudflare) 维护。当前支持的入口和可运行应用见 [Host 配置](../../docs/host/configuration.md#独立轻量-host) 和[三端示例](../../projects/host-targets/README.md)。

## 跨 isolate 的可写状态

需要多个请求在 isolate 回收后继续访问同一逻辑 Host 时，可评估让一个 SQLite Durable Object 持有该 Host 的根文档。路由按业务身份选择对象，每次调用仍传入自己的 Request、binding 和取消信号。验证应覆盖两个写入者读取同一 revision 后提交、写入失败、对象回收重开，以及 TinyBase `flush()` 已确认的数据能否恢复。 [Host 文档存储](../FS.md#host-文档与关闭) · [TinyBase](../TINYBASE.md) · [Durable Object 生命周期](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)

浏览器需要同类恢复能力的应用可用 IndexedDB 挂载。向多个标签页开放同一可写数据集前，需要以实际存储后端验证并发写入者、配额耗尽与重开后的确认版本。 [浏览器 Host](../../docs/host/configuration.md#浏览器-host)

## 平台服务与承载

- **HTTP 路由与 Commands。** 静态 lowering 和业务 SDK 已有跨端实例。接入具体服务时，用其完整依赖闭包和真实的路由、授权与流式响应验收。Elysia 的外部承载、路由冲突和关闭职责见 [Elysia 提案](NATIVE_ELYSIA_APPLICATION.md)。
- **Workbench 与远程开发控制台。** 浏览器内嵌会话需要定义私有 MessagePort 的调用主体。Cloudflare 远程会话还需验证 WebSocket 升级、资产授权、断连后释放及更新时的 session epoch。传输和授权的未决部分见 [Agent 执行与控制](AGENT_WORKFLOW.md) 和 [Workbench 会话](../WORKBENCH.md)。
- **依赖平台能力的插件。** 按具体消费者验证文件操作、持久字节格式、数据库事务或原生模块。对 Worker 文件型插件量测其真实空间与寿命需求。浏览器跨域 Fetch 在两个真实 origin 验证 CORS，部署有 CSP 或特定引擎约束时用相应生产制品验收。 [文件装配](../FS.md) · [出站 HTTP](../OUTBOUND_HTTP.md)
