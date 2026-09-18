# 可组合服务：剩余迁移与验证

Core token、正向 Host 安装计划、官方服务拆分、Management、Workbench、开发附件和共享应用启动已经实施。
当前 API 以[组合 Host 服务](../../docs/reference/runtime-services.md)、[Host 管理接入](../../docs/runtime/management.md)、
[独立 Workbench](../../docs/workbench/standalone-host.md)及[架构约束](../RUNTIME.md)为准；不再通过本提案维护第二份 API 示例。

## 保持的方向

Plugin 基于 Core，必需服务通过 `ctx.require(Token)` 读取。服务安装、资源准备、管理页面与网络承载分别拥有明确的生命周期。
应用用固定 `plugins` 和 `sources` 声明目录，在每次启动的 `configure(startup)` 中构造服务和存储配置；Vite 与生产共用启动路径。
管理页面是普通 Plugin，关闭页面不关闭被管理服务。普通 Vite/tsdown 插件复用同一 lowering、artifact 与 candidate 实现。

验证优先复用代表性路径：轻量 Host、自有业务 HTTP、官方管理 Plugin、实际 Workbench 页面、独立安装和搬离工作区的生产产物。
不为每个 facade 复制 graph/lifecycle 测试；测试只在真正的权限、所有权、持久化或发行边界补证据。

## 核心重构尚未收拢的接线

- **Runtime Vite 产品入口。** Host 与 Runtime 已共用 source evaluator、candidate、制品附件、更新记录器和错误诊断；
  HTTP 也已委托同一个 HttpServer 与 Management endpoint。旧 Runtime Vite driver 仍编排既有产品输入、Workbench URL/资源重配和兼容宿主补偿。
  最终移除应随旧产品契约迁移完成，不为合并两个入口再增加统一模式或通用驱动框架。

## 其他剩余工作

- **Runtime 产品适配的最终退场。** 当前保留其既有产品输入、环境绑定、内部发行适配和测试 API，底层已委托 Host 与独立包。
  删除整个包前，需要迁完仍使用这些契约的外部应用和测试宿主；不能把它们改名转发后宣称旧包已完全消失。
- **更多真实下游迁移。** 本仓库 starter 和示例应用采用 Host 声明；Rhythm 等下游没有在此次工作中被修改或启动。
  需要分别验证 Server 与 Electron/嵌入式 fetch 消费，保留其数据库、gateway、native residual 和自有 SPA 的实际边界。
- **扩展部署矩阵。** Node carrier、独立 fetch 和纯 Host launcher 不是 Bun/Deno/Worker conformance 的证明。
  新平台必须验证断连、stream、WebSocket ownership 和原生依赖交付，不能仅凭 Fetch 类型兼容宣称支持。
- **上游声明修复。** capnweb 0.12.0 在 TypeScript 6/7 的完整声明检查中存在两处 TS2574；独立安装检查明确记录这一已知上游错误，
  不使用 `skipLibCheck` 掩盖其他诊断。上游发布修复后应移除精确的已知诊断例外，不引入第二份 RPC implementation。

## 后续验收规则

未选择服务不应因可解析于开发工作区就被自动收集到产物。固定 Plugin 沿实际依赖构建，动态来源需要的额外 framework 入口通过
`sourceFrameworks` 显式声明。继续检查真实 artifact inventory、搬离工作区的启动/关闭和浏览器资源，不能以 tree-shaking 推测代替验证。

`headless` / `workbench` 仅保留为现有构建资源选择，不作为 Host 的运行模式，也不增加服务安装禁令。
应用显式选择服务和 HTTP/UI 接入；实际需要的制品或文件不存在时，由使用它的服务报告具体错误。
未选择的能力仍应避免进入产物闭包。服务声明变化替换 Host，普通 Plugin/制品更新复用 Host；失败准备不发布半成品。
