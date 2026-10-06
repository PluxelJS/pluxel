# Host 下游与部署验证

本页是历次验证记录，测试数量与结论只属于对应轮次；不是本次 checkout 的测试结果或持续支持承诺。运行当前验证见 [TESTING](TESTING.md)。

Core token、正向 Host 安装计划、官方服务拆分、Management、Workbench、开发附件和共享应用启动已经实施。
官方运行时与 Vite 附件组合使用 Services 的 `/preset`、`/vite`；应用构建统一使用 `@pluxel/rolldown` 的 `pluxel()`；通用 Host-vite 不拥有官方服务选择策略。
当前 API 以[组合 Host 服务](../docs/host/services.md)、[Host 管理接入](../docs/host/management.md)、
[独立 Workbench](../docs/workbench/standalone-host.md)及[架构约束](HOST.md)为准；本文只记录下游验证及其边界。

## 保持的方向

Plugin 基于 Core，必需服务通过 `ctx.require(Token)` 读取。服务安装、资源准备、管理页面与网络承载分别拥有明确的生命周期。
应用用固定 `plugins` 和 `sources` 声明目录，在每次启动的配置工厂中构造服务和存储配置；native 与 Vite 共用该应用合同。
管理页面是普通 Plugin，关闭页面不关闭被管理服务。普通 Vite/tsdown 插件复用同一 lowering、artifact 与 candidate 实现。

验证优先复用代表性路径：轻量 Host、自有业务 HTTP、官方管理 Plugin、实际 Workbench 页面、独立安装和搬离工作区的生产产物。
不为每个 facade 复制 graph/lifecycle 测试；测试只在真正的权限、所有权、持久化或发行边界补证据。

## 真实下游迁移验证

三个独立下游使用同一 `defineHostApplication(factory)` 启动契约，按实际产品选择服务；不靠复制框架源码路径或私有 Shell 入口接入。

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

未选择服务不应因可解析于开发工作区就被自动收集到产物。固定 Plugin 沿实际依赖构建，原生来源需要的额外共享包通过 `runHostApplication()` 的
`sharedPackages` 声明；modules 保留真实包依赖，standalone 只交付固定 catalog。继续检查真实 artifact inventory、搬离工作区的启动/关闭和浏览器资源，不能以 tree-shaking 推测代替验证。

`headless` / `workbench` 仅保留为现有构建资源选择，不作为 Host 的运行模式，也不增加服务安装禁令。
应用显式选择服务和 HTTP/UI 接入；实际需要的制品或文件不存在时，由使用它的服务报告具体错误。
未选择的能力仍应避免进入产物闭包。服务声明变化替换 Host，普通 Plugin/制品更新复用 Host；失败准备不发布半成品。

## 包边界整理验证

上一轮将组合与测试宿主移到独立 Preset 包，曾验证当时的发布图无环。该拓扑已被当前合包设计替代，不能作为当前依赖图结论。

上一轮通过 10 个相关框架包的类型检查、42 项原有定向测试、Services/Management/Preset 分阶段独立安装检查与 starter 检查；移动后的 Preset 测试也验证了入口解析。三个下游仅重跑受影响包的类型检查：Rhythm 15 个、Chatbot 13 个及根项目、Omni 11 个；没有重复上述整套业务与部署验收。

当前整理把 Logging、Management、preset 与组合测试归入 Services，动态来源归入 Host，官方 Shell 归入 Workbench。包级可选互相引用不再等同于模块循环；本轮验收需检查基础入口不加载未选择后端、浏览器协议独立求值、合包后的真实安装与下游入口。上述上一轮结果不代替这些验证。

本轮合包后已通过：框架 source build 的 15 项任务；Host、Host-vite、Services、Workbench 与 Shell 类型检查；Services/Logging 35 项、Management 145 项、Shell 265 项和动态来源 4 项现有测试；基础服务与完整 UI 两阶段的独立安装检查、14 项仓库治理测试及 8 项 starter 测试。Shell 并发运行中的两项超时在限制并发后单独通过，未扩大超时阈值。动态来源测试改为验证文件事件契约，不再要求同次写入恰好一次通知。

三个下游再次完成 source 安装与受影响包类型检查：Rhythm 15 个、Chatbot 14 个及根项目、Omni 11 个。没有重复全部业务测试或外部平台连接验收。

真实 Vite Workbench smoke 同时验证语义候选拒绝（保留旧制品并记录 application artifact error）、后台 producer 构建失败、修复恢复、旧制品可读与关闭。Host hot-update 的原始异常已确认进入显式选择的日志后端；对应 Host-vite 单包构建与既有诊断测试通过。

## 配置与 Vault 重设计验证（2026-09-22）

本轮改为明确的 `envBindings` / `fileBindings`、config base/saved/env 分层和结构化 Vault KV。框架通过 Core 242、Rolldown 357、Host 119、Host-vite 54、Services 306、Auth 46、S3 16 项回归；Host 额外验证 binding 输入隔离、来源缺失、文件输入、replacement schema 与 transform 执行次数。S3 在仅安装 `vault({ backend: 'bindings' })`、没有 Persistence 时向本地 HTTP 服务完成真实签名写入。仓库治理、lint、format、22 项类型/构建任务及独立 tarball/Vite smoke 已通过。

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
- Host 124 项测试、Rolldown 365 项测试、Host-vite 54 项测试、Services 的真实 Vite 启动/HMR 测试通过；对应 Host、Rolldown、Host-vite、Services 类型检查通过。Host 与 Rolldown 独立构建通过。
- Auth 46 项、S3 16 项测试及两个包的构建/类型检查通过；S3 覆盖 bindings-only 后端的实际签名请求。Chatbot 343 项测试、17 包及根项目类型检查和静态构建通过；Omni 19 项类型/构建任务、16 项测试任务通过；Rhythm 37 项类型检查、11 项生产构建/制品/启动检查通过；Backend 26 项类型检查及本轮涉及的四个连接器测试通过。各应用的 `.env.example` 继续从显式 schema 提取约束。
- 根仓库治理、lint 与 format 检查通过；源码扫描确认框架、官方插件和四个 local-projects 均没有两个 static schema 声明残留。没有修改 TypeScript 版本、要求编译器插件或改变插件文件扩展名。

上述检查针对本轮 schema 声明与绑定变化，不替代上一节对凭据存储、Workbench 布局和外部平台连接的验证边界。

## Native modules 与 Vite 生产执行

实施与三路独立复核完成：2026-10-04 至 2026-10-05。本轮已完成框架、调用方、测试、文档与发行说明迁移；未通过和未验证的边界在本节明确保留。必要决策及实际反例见[实施记录](proposals/VITE_DYNAMIC_RUNTIME.md)。当前用法见[Host 配置](../docs/host/configuration.md)、[应用构建](APPLICATION_BUILD.md)、[HMR](HMR.md)和[Package Manager](../docs/plugins/package-manager.md)。

本轮以真实 Node 进程、独立 tarball 安装和实际 Vite 事件补齐单元测试不能证明的共享身份、文件观察和关闭边界。发现的反例及修正进入原实施记录，不保留旧 API 形状。

本轮没有操作已有在线应用；所有运行验证使用隔离目录、临时数据、本地 npm registry 和新建 Node/Vite 进程。

- Host 142、Host-vite 113、Services 341、Rolldown 461、Workbench 458、Shell 267、CLI 94、create 8、Package Manager 16 项回归通过。Package Manager 的一个外部 npm 网络门控测试维持跳过，真实本地 registry/pnpm 的 A/B/P 样本已运行。最终完整套件限制 4 个 worker；没有扩大断言的超时或延长恢复等待。
- native fresh-process admission 在 resolve hook 拒绝 Vite、Host-vite、Rolldown、Oxc、chokidar 时仍成功；缺少/错误 ABI、原始 TS、CommonJS entry、未声明/错误实际版本以及共享绑定冲突均明确失败。`import.meta.resolve` 指向会抛错的未使用模块也不会执行它。
- modules 的 5 项真实构建回归保持包 imports、公开唯一 constructor、private source-entry、product、合法 `./__proto__` 和 Node worker；默认 minify，搬移输出、删除 src、只读目录后均能 native 和生产 Vite 启动。编译 SPA 的 HTTP/资源成功，保留路径拒绝源码入口；最后的 Ed25519 目录签名验证仍通过，编译 inventory 篡改在启动前拒绝。此签名不证明外部 package 安装或可变来源目录。
- 真实 pnpm + PackageManagerPlugin 样本覆盖 A/B 独立、共同 P、仅 A 使用 P、普通 ESM node_modules 修改、固定依赖 Host replacement、语法拒绝/修复和 uninstall。未受影响 B 的 wrapper bytes、inode/mtime、物理目标、constructor、instance、generation/recent report 和 Node artifact 保持不变；共同 P 无重复身份。旧实例的 late import/资源在升级与卸载后仍可读；新 native 进程读取新发布入口。另有失败发布回执、损坏发布记录和跨进程写者冲突回归。
- 同一生产 Vite session 的业务 HTTP/WebSocket 成功，Host replacement 保持端口；无 browser Vite middleware、console socket 或 source Shell。再次启动启用真实 compiled Workbench inventory，Shell HTML/JS 成功。两次关闭后 FSWatcher、StatWatcher 和 listening Server 数回到进程初始基线，AbortSignal 与重复 close 排空工作；Vite 与三轮 Native 子进程均自然退出，code 0、signal null。
- 新入口拒绝非 production 进程、relative/conflicting root、零/多个 Host、开发控制台/source Shell 与非法 options；service prepare 失败后验证 drain 和正常退出。既有开发 console、失败导入恢复、fixed imports HMR 和 standalone 发行回归保留。
- 已安装 Plugin 与 Node 制品的独立真实 Vite smoke 通过，验证语法拒绝后立即修复、应用工厂重建、资源清理和自然退出。迟到包通知回归在旧实现稳定复现多一次更新；修正后报告序号、实例与 lifecycle 事件均符合原断言，不靠放宽等待使其通过。
- Host-vite 的 5 项新回归使用真实发行 CLI 执行 setup/doctor，验证成员包的 CLI 声明不改变 workspace 根、显式坏子根仍拒绝、Git/lockfile 边界不借父安装、未接入 fixture 不写 setup。原完整 Host-vite 套件含这些回归共 113 项通过。HTTP 启动与清理同时失败的内层 cause 在旧实现真实端口占用样本中失败；修正后原有 HTTP 7 项与 standalone 2 项回归通过，不只检查最外层错误。
- SDK 的 14 项完整构建、参考 Host 的 28 项构建任务、10 个受影响包（含参考 Host）的类型检查、37 项治理、仓库 lint 与 1971 文件 format 检查通过；公开导出、声明与文档迁移已复核。CLI 实际 Turbo 输入清单包含 70 篇 docs 与开发 skill，缓存跟随所打包的权威正文失效。
- 最终 starter smoke 从 11 个真实本地 tarball 安装独立 SDK，执行真实 create、setup 和完整 verify；15 项项目检查全部通过，modules distribution inspect 的 64 个条目完整。Fresh Native 在工具链 resolve 禁止 hook 下完成 Todo HTTP、修改、SPA 和 compiled Workbench；生产 Vite 完成业务 HTTP、编译页面和 Workbench JS，开发路径均 404，SIGTERM 关闭退出 0。开发 Vite 完成浏览器模块图、业务操作、Workbench 导航和固定绝对 root/准确 instance 的控制台检查，4 个应用 Plugin 运行，Vault 使用 built-module。安装后的 3 篇相关 CLI docs 与本仓权威正文逐字节一致。
- 完整 Services installed-declarations 检查仍失败。最小输入只创建 `Elysia`，在已安装 Elysia 2.0.0-beta.19、TypeScript 7.0.2、`strict: true`、`skipLibCheck: false` 下独立复现 79 个 macro/generic 声明诊断，见[隔离复现](experiments/elysia-declarations/README.md)。没有新增宽泛例外或改库声明；此前 capnweb 0.12.0 的两处精确 TS2574 例外未扩大，运行 smoke 通过不能代替该检查。

A/B/P smoke 通过 `PLUXEL_RUNTIME_METRICS_FILE` 可导出一次运行的耗时/RSS；这些测量没有去除同机其他验证的 CPU/IO 竞争，不用于承诺提速。本轮样本为：

| 样本                                            | 从操作开始到观察提交 | RSS     |
| ----------------------------------------------- | -------------------- | ------- |
| production Vite 冷启动                          | 3754 ms              | 288 MiB |
| A2 install 与在线接纳                           | 639 ms               | 338 MiB |
| 共同 P2，并包含普通依赖变更、工厂重建与语法恢复 | 1075 ms              | 353 MiB |
| B3 install 与在线接纳                           | 212 ms               | 357 MiB |
| 仅 A 使用 P3 的 install 与在线接纳              | 334 ms               | 366 MiB |
| 移除 A 并观察 catalog                           | 340 ms               | 369 MiB |

Native 的证据前提是 fresh Node launcher 在业务闭包首次求值前建立 scope；它不证明任意提前求值依赖的旧 namespace 能被重新绑定。Node/Vite 会保留已求值模块，Package Manager 有意保留旧安装字节。该有限样本和两轮资源释放不证明长期 RSS 无增长；本轮没有完整浏览器交互验收，长期负载、外部真实业务平台和 Bun/Deno/Worker conformance 未验证。

### 再复核与真实调用方迁移（2026-10-05）

再次复核确认旧 Host-dev 包、低层文件执行、framework facade、旧 scope reader 和兼容形状已从当前执行路径删除。最终框架 imports 与当前 exports 一致；42 个变更 Markdown 的 277 个相对本地链接存在。还修正了模板两处旧构建入口说明和 Backend 的旧 source lock 指引。历史 changelog、已标明范围的证据记录和拒绝旧输入的负向回归保留。

- 唯一 forced SDK/官方参考 Host 构建完成 28 项任务，0 cache，1m55.32s。Host 143、Host-vite 114、Rolldown 469 项完整回归通过，覆盖新的增量 namespace、cached application prefix、物理 owner 冲突、初次来源观察与原恢复/关闭断言。
- Package Manager 完整套件单 worker 通过 16 项，保留一个外部 npm 门控跳过。此前并行检查中，首次 fresh Node readiness 在原 poll 期限内失败且 stderr 为空；隔离完整复验使用原断言和期限。类型检查任务曾带入同 key 的 Turbo 构建缓存恢复，随后已停止该调度路径；不把受扰动窗口的失败改写为绿色记录。
- 官方参考 Host 的 11 项应用测试、应用类型检查和 2 项实际生产 runtime smoke 通过。Native 在 hook 禁止 Vite/Host-vite/Rolldown/Oxc/tsx/TypeScript/chokidar 时运行固定 catalog；Native 与生产 Vite 都完成 showcase、compiled Workbench HTML/JS、开发路径拒绝以及 SIGTERM 自然退出 0。开发控制台按发现的绝对 root/准确 instance 验证 18 个启用 Plugin 运行、无 issue，两个 HTTP 路由成功及有界日志；临时 Vite CLI 用 SIGTERM 结束，此退出不计为生产 drain 证据。
- Rhythm 的实际本地数据完成单次离线地址转换：Kook 配置 owner 和 autoStart 各一条，18/20 条目数及其他值保持不变，Vault 三个文件字节不变。当前 Vault v2 无 namespace/KV/blob；历史备份不改。完整 persistence 备份保留在应用 `.pluxel/identity-migration-backups/`，复制演练覆盖两种碰撞、原解析 cause、第二写失败回滚和回滚聚合 cause，维护脚本不进入仓库或运行时。

- Workbench 的真实 standalone 回归同时覆盖空 catalog、显式 VaultAdmin 与同模块双 Plugin 仅选一个；未选 renderer/Markdown 文件不存在，所选 MF/Content 树、删除源码后的 fresh Node catalog 和正常关闭均通过。完整 Rolldown 为 42 文件、469 tests、56.27s；所选 snapshot 失效回归在旧全局清理 mutation 下实际失败。工具链类型、lint 与最终直接构建通过，没有再次用 Turbo 恢复共享 SDK 输出。
- Chatbot 的 17 包与 root 类型检查、58 文件 354 tests、治理及真实 NAPI/standalone 构建通过。最终产物无工作区 symlink，搬移后保留原 18 节点 catalog/15 节点启动策略，真实 Node/Hoshino、Workbench HTTP/RPC、PGlite、清单完整性与 SIGTERM 自然退出 0/null 通过两次隔离验收。首次紧接构建后的原 15 秒启动检查未监听、stdout/stderr 均为空，清理由 SIGKILL 完成；原因尚未确定，该失败不改记为通过。后续隔离使用同一产物、原期限和完整断言；MF gallery 的既有 export-analysis 10 秒警告及 optional zlib-sync/decorator/eval 警告未靠调整配置消除。
- Rhythm 的 71 项质量任务无缓存通过；最后 KOOK 增量回归为 8 文件 43 tests，实际合并统计 954 tests passed、一个既有 TeamSpeak 外部门控 skip。真实发行 finalize 10/10 无缓存通过，随后应用、前端、生产 smoke 按顺序全部通过；原 11 个 Workbench producer 断言保持不变，不再交付 VaultAdmin，清单从 629 降到 599 条，生产自然退出 0/null。原并行运行曾在默认 1500ms 生命周期期限内失败；隔离原检查通过，串行验证调度成为项目的显式流程，未延长期限或放宽恢复断言。
- Rhythm Desktop 的完整既有验证分别完成：35 文件 250 Vitest、10 Rust、静态检查、Vite renderer 与 headless 浏览器验收；完整 build 与 bundle 边界通过。新增搬移产物的两次 fresh Node fetch 验证 provider/playlist、同一 SQLite 写读与关闭，TCP/FS/Stat 资源回到基线并自然退出 0/null；没有把它作为 Electron 安装包或真实 GUI 的证明。
- Omni 的实际 `verify:workspaces` 完成 25/25 类型、25/25 测试和 27/27 构建任务，均强制无缓存；24 个测试包共 211 文件 1605 passed、一个既有 `ECONOMY_TB_TEST` 门控 skip。前期并行运行的原 Poll、giveaway migration 与 UserFacts 生命周期期限失败均保留，原测试隔离通过；验证脚本固定类型/构建并发 3，测试任务串行、每包 2 workers。之后仅修改 Jieba 实际 subpath 并新增 fresh Node 用例，wordcloud 7/7、类型/lint/format 通过；未把该增量重测与全套重复相加。最终 Host build 961 条清单完整，搬移后缺少 TigerBeetle 输入时自然退出 1/null、没有强杀，前后清单及 manifest SHA 不变。Web 的 89 文件 430 tests 验证当时快照，不覆盖此后用户独立进行的界面修改，这些修改不纳入本次提交。
- Backend 的 24/24 类型、37 项测试任务、25/25 构建任务与治理通过；本轮实际测试日志共 103 文件 619 passed、一个既有 jj-ledger skip，旧 Turbo 日志中的 18 个用例不计入本轮。提交前 504 条发行清单与原生产 smoke 验证 SPA/RPC、guest 失败、两项 AgentENV 负例、清单不可变与 SIGTERM 自然退出 0/null。provenance 使用构建时实际 SDK Git HEAD；提交顺序为 SDK 先提交，再按新 HEAD 重建 Backend Host、执行原生产 smoke，最后提交下游，不再复制旧 source lock。

以上本地项目已完成当前调用方、依赖、AGENTS 与使用文档迁移，现行源码扫描没有旧 HostDev、旧平台包名、source lock、source loader 或 KOOK flat wrapper；负向回归和历史记录仍保留明确范围。外部真实 Bot/音乐账号、生产 PostgreSQL/Turso/TigerBeetle/Inngest、TeamSpeak live E2E、Electron 安装包及三平台发行、Chatbot 浏览器 remote 渲染未验证。Services 完整已安装声明检查仍存在前述 79 项 Elysia 上游诊断。

实际 FS 与加载事实计数如下；8/32/64 个入口均使用同样的真实目录及独立 fresh Node 样本。这些是操作数量，不是耗时或长期 RSS 承诺。

| 64 个入口样本                  | 再复核前 | 修正后 |
| ------------------------------ | -------- | ------ |
| Native owner manifest 读取     | 2273     | 193    |
| Native 累计前缀存储的 URL 引用 | 2145     | 65     |
| Vite 首次目录 readdir          | 68       | 3      |
| Vite 首次叶子 lstat            | 4352     | 192    |

Native 成功入口共享一份唯一 URL 序列并各自持有固定长度，关闭冻结事实；错误 owner/ABI 不标记成功。Vite 只合并 SDK 的首次观察 epoch，live 事件及每次 entries 消费继续完整校验。两者均保留最早能够可靠判定的输入错误与清理所有权。

### 架构边界与失败恢复复核（2026-10-05）

本轮按执行接纳、包发布、构建交付三条路径独立审查并交叉复核。保留现有 Native/Vite 执行分工、Host/Core 生命周期和文件来源协议；没有增加通用 loader、适配器层、第二套更新队列或兼容入口。

修正集中在现有所有者的接纳与结算时机：Host 在异步准备前捕获声明并拒绝未知字段，应用绑定先捕获路径和映射再读取；Vite 观察器就绪后才替换旧观察器，生产入口校验最终配置；Package Manager 初始化、读取和修改复用同一队列，未撤回入口从文件事实派生并提供重试；构建清单使用实际输出 chunk；显式 Node 制品来源不被开发编译器覆盖，清理失败不跳过剩余资源。

新增绑定回归曾在综合检查中先于对应实现被执行，出现 `FILE_READ_FAILED`；修复完成后的 Host 全套 149 项通过。该次综合检查是失败记录，不算作最终验证通过。

最终使用 `VITEST_MAX_WORKERS=1 pnpm verify`，筛选 Host、Host-vite、Rolldown、Services、Package Manager、Storage，Turbo 并发 1、强制重跑：28/28 类型、构建与测试任务通过，零缓存，耗时 5m17.163s；仓库治理 37 项、lint、1978 文件格式及源码声明检查通过。各包测试分别为 149、121、470、344、22、17，共 1123 项通过；Package Manager 保留一个外部 npm 门控跳过，真实本地 registry 样本执行。

此前双 worker 的 Rolldown 全套为 469 passed / 1 failed：standalone 双失败回归在具有原 30 秒期限的构建子进程中失败，日志不足以确认原因。该文件按原断言、原期限隔离运行 3/3 通过（6.58s），最终完整复验 470/470 通过；没有修改期限或放宽断言。Node setup 与 cleanup 双失败回归另确认原实现丢失 setup 原因，现同时保留两个错误并以 setup 为 cause。

2026-10-06 复核更正：Vitest 5.0.2 支持 `VITEST_MAX_WORKERS`，但当前 Turbo strict 模式未声明透传该变量，实际 test task 的 dry-run 环境清单中也不存在它。Turbo 并发 1 不约束各包内部 worker。保留实际通过数和隔离结果，撤回对该完整命令的单 worker 推断；本轮 Services 使用所属 `vitest.config.ts` 的显式 `test.maxWorkers: 1`，不改变原测试期限或断言。

本轮不重复此前独立 tarball 安装、所有下游生产部署或在线控制台验收，也不证明长期 RSS、吞吐量或外部平台连接。前述 Services 已安装声明的 Elysia 上游问题不因本轮源码检查通过而消失。

### 构建入口收口与调用方验证（2026-10-06）

实际实现复核发现 `buildPreset()` 只有转发和重复 Workbench 默认值，没有独立构建契约。删除 Services 的该源码、source/publish export 和构建条目；应用统一直接调用 `@pluxel/rolldown` 的 `pluxel()`。保留有独立服务组合、Vite 附件和 Plugin package 契约的入口。官方 Host、Create 模板、首页示例、公开文档和四个本地项目同步迁移；修正将所有应用构建描述为冻结的旧说明，以及 Rhythm、Backend 已不存在的根 `web/` 职责指引。Tegami 记录 Services major、Create patch，不手改版本或 publish lock。

初次强制验证在文档站 SSG 失败：两处 Host 用法把 `engineering/HMR.md` 当成站内页面，而站点只发布 `docs/`。改为链接仓库权威章节，保留原链接检查。第二次强制验证在 Services 为 342/344，两个用例在原 5000ms 期限超时；该次 27/32 任务成功，不能计为完整通过。原两个文件显式 `--maxWorkers=1` 隔离复验 4/4 通过，所属 Services 配置固定相同 worker 限制，原期限和断言不变。环境变量的实际边界见上段复核更正。

- 最终执行 `pnpm verify --filter=@pluxel/services --filter=@pluxel/create --filter=@pluxel/plugins-host --filter=pluxel-docs --concurrency=1`：37/37 任务成功，12 项缓存，17m54.333s；治理 37 项、源码声明 6 项、lint、1978 文件格式检查通过。Services 为 64 文件、344 tests、165.91s，Create 8 项；官方 Host 5 文件、11 项包含两项 Native/生产 Vite runtime smoke，未重复相加。官方构建为 modules，实际 catalog、Workbench HTML/JS、开发路径拒绝及 SIGTERM 自然退出 0/null 通过。文档站生成 618 个文件并通过链接检查。
- 独立 starter smoke 从 11 个真实本地 tarball 安装 SDK，执行 create、setup 和生成 workspace 的完整 verify：15/15 项任务成功、零缓存，36.101s；modules 清单 64 项完整。Fresh Native 在禁止执行工具 resolve hook 下完成 Todo、修改、SPA 与 compiled Workbench；生产 Vite 完成业务、Shell/JS 和 SIGTERM 自然关闭，开发 Vite 完成业务、模块图、Workbench 和固定 root/instance 的 dev console。临时应用与安装目录已清理。
- 实际 Services tarball 无旧构建 export、`dist/build.mjs` 或配套声明；安装后的旧子路径解析得到 `ERR_PACKAGE_PATH_NOT_EXPORTED`，生成 Host 使用直接 `pluxel({ delivery: 'modules' })`。五篇安装后 CLI 用法与当前权威正文逐字节一致。额外一次打包探针曾误猜 Rolldown 输出名为 `application.mjs`；实际公开 export 指向 `index.mjs`，探针改为消费 package exports 后通过，未为该误判修改 SDK。
- Chatbot 的本地 NAPI/Host 构建通过，发行清单 797 项；原严格搬移 smoke 在原 15 秒 readiness、8 秒退出期限内验证 18 节点 catalog、15 节点生产启动和其余 3 节点 stopped、issue 为空、Workbench HTTP/RPC、隔离 PGlite、无 Vite client，SIGTERM 自然退出 0/null。保留既有 MF gallery 完整 export analysis 的 10 秒 idle-timeout 警告，没有调整该配置。
- Rhythm 的原清理、Host 构建、finalize 和生产 smoke 均通过，发行清单 599 项。原 11 个 Workbench producer、页面/API、CORS、GraphQL/RPC、env 输入不落盘及 8 秒 SIGTERM 退出 0/null 断言保留。实际清理脚本同时删除 `host/dist` 和 `host/web/dist`，因此先显式备份未改的浏览器 12 文件，执行原 clean 后逐字恢复并核对同一 fingerprint，再构建 Host；临时备份已清理，没有修改清理脚本或运行时。
- Omni 本地 Host 构建通过，搬移发行清单 960 项；原严格缺少 TigerBeetle 输入负向 smoke 自然退出 1/null，无强杀，运行前后清单和 manifest SHA 一致。构建覆盖当时用户业务快照，未复验这些业务变更的完整测试；本轮仅提交其 Host 构建入口。

Backend 的 provenance 继续使用实际 SDK Git HEAD：主仓先提交，再按新 HEAD 构建 Backend Host、执行原生产 smoke，最后提交下游。公共入口清理不构成长期 RSS、吞吐量或外部账号的性能/连接证明；前述 Services 已安装声明的 79 项 Elysia 上游诊断仍保留。
