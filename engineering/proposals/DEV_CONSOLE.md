# Development Console: Remaining Directions

在线 TypeScript 文件执行、独立 dev API、配置编辑、Workbench RPC、插件实例访问、日志与本地执行通道已实现。当前约束见 [`../DEV_CONSOLE.md`](../DEV_CONSOLE.md)，使用方式见 [`../../docs/development/dev-console.md`](../../docs/development/dev-console.md)。

以下仍未实现，不构成当前 API 承诺：

- 浏览器脚本编辑器与 inline TS cells：复用同一执行内核，明确 import base、local authorization/Origin 和代码提交边界，不另建模块 runner。
- 持久 scratch bindings：只有真实工作流证明 JSON input/result 不够时再设计；区分可保留数据与 generation-scoped handles，明确失效和 disposal，不用全局 Map 保活任意对象。
- 通用 SQL admin：定义 active instance、owner role、statement/timeout、outbox 与权限后再增加；当前通过 Plugin 业务方法或其有意公开的 database handle 操作。
- Windows 本地通道：在能够验证 named pipe ACL、discovery 权限和实例认证后支持，不能仅凭 pipe 名称随机就声明等价的用户隔离。

每项扩展先证明现有窄接口无法满足的具体场景，再定义公开契约与真实边界验收。test 与 dev 可以共用能力实现，不要求合并为同一个 host API。
