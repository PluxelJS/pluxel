# Host 下游与部署验证

Core token、正向 Host 安装计划、官方服务拆分、Management、Workbench、开发附件和共享应用启动已经实施。
官方运行时、Vite 与构建组合分别使用 Services 的 `/preset`、`/vite`、`/build`；通用 Host-dev 不拥有官方服务选择策略。
当前 API 以[组合 Host 服务](../docs/reference/runtime-services.md)、[Host 管理接入](../docs/runtime/management.md)、
[独立 Workbench](../docs/workbench/standalone-host.md)及[架构约束](HOST.md)为准；本文只记录下游验证及其边界。

## 保持的方向

Plugin 基于 Core，必需服务通过 `ctx.require(Token)` 读取。服务安装、资源准备、管理页面与网络承载分别拥有明确的生命周期。
应用用固定 `plugins` 和 `sources` 声明目录，在每次启动的 配置工厂 中构造服务和存储配置；Vite 与生产共用启动路径。
管理页面是普通 Plugin，关闭页面不关闭被管理服务。普通 Vite/tsdown 插件复用同一 lowering、artifact 与 candidate 实现。

验证优先复用代表性路径：轻量 Host、自有业务 HTTP、官方管理 Plugin、实际 Workbench 页面、独立安装和搬离工作区的生产产物。
不为每个 facade 复制 graph/lifecycle 测试；测试只在真正的权限、所有权、持久化或发行边界补证据。

## 真实下游迁移验证

三个独立下游使用同一 `defineConfig(factory)` 启动契约，按实际产品选择服务；不靠复制框架源码路径或私有 Shell 入口接入。

- **Chatbot：** 固定平台 catalog、官方 Workbench Shell 与显式 PGlite Database；保留既有 Vault、配置目录和内存 auto-start 策略。
  已通过全部 340 个现有测试、package/root 类型检查、source governance 与生产构建。隔离生产启动验证 Workbench HTML 及其 11 个 JS/CSS 资源返回成功且 MIME 正确。
- **Rhythm：** Server 使用官方服务组合与自有 LibSQL；Desktop 仅安装 HTTP、持久化、Vault 和日志。
  已通过消费侧 31 项测试任务、Desktop 250 个现有测试与原生 streamer 测试。原生验证复用 release 构建，避免 debug/release 同时覆盖同一二进制。
  Desktop 的真实 fetch 产物在临时数据目录启动，五个 provider/account 路由可用，Management/Workbench 路由不存在，最终关闭成功并自然退出。
  Server 生产构建与 launcher 验证通过，覆盖页面、业务 API、Workbench inventory 和 SIGTERM 关闭。
  独立消费仓的开发应用与前端验证通过，覆盖七个 provider、管理面、Workbench、动态 provider 生命周期及 GraphQL/RPC 权限。
- **bot-new-omni：** 官方服务组合加显式 Database；保留开发 PGlite、生产 PostgreSQL 策略及独立 KOOK store。
  已通过全部现有测试与工作区类型检查，包括 Web 的 150 个测试；测试图显式声明默认 Cache provider，不再依赖旧测试宿主的隐式发现。
  前端、后端与 distribution 构建通过。独立消费仓在 Workbench 关闭和开启时均通过真实 Vite 验证：控制台操作成功、插件运行、
  lifecycle/reconciliation 无错误，服务及真实 HTTP carrier 均返回预期的未认证 401；SIGTERM 关闭无强杀或资源释放错误。
  应用通过 Host 配置声明 30 秒插件启动期限，包含冷 PGlite 初始化及生产数据库迁移；不改变 Core 默认期限。

这些验证使用隔离数据，不代表已有账号的真实平台连接、消息投递或生产数据库升级已验收。

## 待验证的外部部署边界

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

## 包边界整理验证

上一轮将组合与测试宿主移到独立 Preset 包，曾验证当时的发布图无环。该拓扑已被当前合包设计替代，不能作为当前依赖图结论。

上一轮通过 10 个相关框架包的类型检查、42 项原有定向测试、Services/Management/Preset 分阶段独立安装检查与 starter 检查；移动后的 Preset 测试也验证了入口解析。三个下游仅重跑受影响包的类型检查：Rhythm 15 个、Chatbot 13 个及根项目、Omni 11 个；没有重复上述整套业务与部署验收。

当前整理把 Logging、Management、preset 与组合测试归入 Services，动态来源归入 Host，官方 Shell 归入 Workbench。包级可选互相引用不再等同于模块循环；本轮验收需检查基础入口不加载未选择后端、浏览器协议独立求值、合包后的真实安装与下游入口。上述上一轮结果不代替这些验证。

本轮合包后已通过：框架 source build 的 15 项任务；Host、Host-dev、Services、Workbench 与 Shell 类型检查；Services/Logging 35 项、Management 145 项、Shell 265 项和动态来源 4 项现有测试；基础服务与完整 UI 两阶段的独立安装检查、14 项仓库治理测试及 8 项 starter 测试。Shell 并发运行中的两项超时在限制并发后单独通过，未扩大超时阈值。动态来源测试改为验证文件事件契约，不再要求同次写入恰好一次通知。

三个下游再次完成 source 安装与受影响包类型检查：Rhythm 15 个、Chatbot 14 个及根项目、Omni 11 个。没有重复全部业务测试或外部平台连接验收。

真实 Vite Workbench smoke 同时验证语义候选拒绝（保留旧制品并记录 application artifact error）、后台 producer 构建失败、修复恢复、旧制品可读与关闭。Host hot-update 的原始异常已确认进入显式选择的日志后端；对应 Host-dev 单包构建与既有诊断测试通过。

## 配置与 Vault 重设计验证（2026-09-22）

本轮改为明确的 `envBindings` / `fileBindings`、config base/saved/env 分层和结构化 Vault KV。框架通过 Core 242、Rolldown 357、Host 119、Host-dev 54、Services 306、Auth 46、S3 16 项回归；Host 额外验证 binding 输入隔离、来源缺失、文件输入、replacement schema 与 transform 执行次数。S3 在仅安装 `vault({ backend: 'bindings' })`、没有 Persistence 时向本地 HTTP 服务完成真实签名写入。仓库治理、lint、format、22 项类型/构建任务及独立 tarball/Vite smoke 已通过。

Workbench 446 项通过。全套检查另外暴露 `workbench-editor-grid.test.tsx` 的最大化恢复失败，单独复验仍失败；其 adapter/test 未被本轮修改，工作区已存在的 `vendor/split-like-vscode` revision 变更保留原状。这项独立布局问题不计入通过数。

- Chatbot：17 包及 root 类型检查、343 项测试覆盖和完整构建通过；负载期超时的 3 个文件单 worker 复验通过。新增回归覆盖账户分页、外部新增/替换/删除和 observer 清理。
- bot-new-omni：35 项类型、测试及构建任务通过；新增相同业务 revision 下的凭据替换与删除后客户端清理回归。
- Rhythm：71 项检查、应用/前端/生产 smoke 通过；桌面类型检查、250 tests 和 Pluxel build 通过。生产 smoke 断言 env 不写入 saved config。音乐源及 TeamSpeak 覆盖结构化记录迁移、外部更新、删除和 revision 冲突。
- Backend：26 项类型、40 项测试和 25 项生产构建任务通过；539 项 distribution inventory 与生产 smoke 通过，覆盖 SPA/RPC、AgentENV 控制面、guest 失败诊断及 SIGTERM。连接设置通过应用显式绑定的 Host config 保存，凭据通过结构化 Vault/CAS 保存；真实 Host 回归覆盖外部轮换、删除与无凭据配置。

这些结果验证本地可重复行为与制品边界，不证明外部平台账号、真实 TeamSpeak 服务器或生产数据升级已被在线操作验证。普通配置迁移与加密数据保留细节以各下游迁移文档为准。

## 移除静态 schema 字段（2026-09-23）

本轮保留普通 `.ts` 和 `this.configs.use(schema)`，应用通过 `envBinding` / `fileBinding` 显式导入 schema。插件不再声明两个 static schema 字段。Config 在启动时核对同一 schema 对象，HMR 继续检查候选 metadata；Vault 根 schema 是本次 Host 的部署输入契约，保留记录 key 和整记录校验，不随 Plugin 热替换重复执行 transform。

- 官方 Content Mapper 实验固定验证 7.0.2 与 7.1.0-dev.20260922.1：前者不支持，后者拒绝内建 `.ts` / `.tsx`；自定义扩展名的 CLI、LSP 和声明消费者路径可运行，但没有用于生产。复现见 `engineering/experiments/tsgo-content-mapper/README.md`。
- 生产公开声明消费者只加载 Core/Host `dist`、不使用 source condition 或 paths，在 TypeScript 7.0.2 的 `strict`、`skipLibCheck: false` 下通过 10 个负例检查。真实 LSP 验证 config/Vault 根字段、嵌套输入字段、file record key 的补全，以及错误 key 的 TS2353。复现见 `engineering/experiments/tsgo-plugin-inputs/check-production.mjs`。
- Host 124 项测试、Rolldown 365 项测试、Host-dev 54 项测试、Services 的真实 Vite 启动/HMR 测试通过；对应 Host、Rolldown、Host-dev、Services 类型检查通过。Host 与 Rolldown 独立构建通过。
- Auth 46 项、S3 16 项测试及两个包的构建/类型检查通过；S3 覆盖 bindings-only 后端的实际签名请求。Chatbot 343 项测试、17 包及根项目类型检查和静态构建通过；Omni 19 项类型/构建任务、16 项测试任务通过；Rhythm 37 项类型检查、11 项生产构建/制品/启动检查通过；Backend 26 项类型检查及本轮涉及的四个连接器测试通过。各应用的 `.env.example` 继续从显式 schema 提取约束。
- 根仓库治理、lint 与 format 检查通过；源码扫描确认框架、官方插件和四个 local-projects 均没有两个 static schema 声明残留。没有修改 TypeScript 版本、要求编译器插件或改变插件文件扩展名。

上述检查针对本轮 schema 声明与绑定变化，不替代上一节对凭据存储、Workbench 布局和外部平台连接的验证边界。
