# Workbench FlexLayout 迁移验收

本页记录 2026-10-13 本地迁移 checkout 的实施证据，不替代当前 API 或持续支持承诺。架构约束见 [Frontend](FRONTEND.md#原生工作区与文档路由) 与 [Workbench](WORKBENCH.md)，用户操作见[工作台使用与排查](../docs/workbench/operations.md)。

静态、集成、制品和公开文档构建已通过；最终主浏览器 20 项检查全部通过，回执为 `ok: true`、`errors: []`、`resourceFailures: []`。真实配置草稿的单独浏览器检查另有 6 项通过，浏览器错误与资源请求失败均为空。在线 Plugin 停止、启动各触发一次完整 document reload，旧 MF 输入脱离，重新打开取得 fresh roots。证据覆盖范围与未验证边界见下文。

## 检查来源与结果

| 检查                  | 已核对的结果                                                           | 证据范围                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Workbench 公开包      | 18 个测试文件、191 项通过                                              | 公开导出、Content/Client DTO、RPC ownership、MF Bridge 与制品契约                                                                           |
| Workbench Shell       | 55 个测试文件、323 项通过                                              | 原生 Worksplit/FlexLayout、实际 App 路由、dirty/save、恢复、Provider 和内容生命周期；包括 committed publication 默认名称与原生名称复用/刷新 |
| 根工作区类型检查      | 66 项任务通过                                                          | 实际 workspace 源码及各包检查入口；不能代替运行时验证                                                                                       |
| Workbench 生产构建    | `build:web`、`build:lib`、Shell inventory 检查通过                     | 浏览器 Shell 与公开包制品；保留正常 chunk-size 提示                                                                                         |
| 独立目录 Vite smoke   | `INDEPENDENT_WORKBENCH_VITE_OK`                                        | 独立临时 root 符号链接本地包，消费已构建 dist/exports；真实 Vite、producer、HTTP/RPC 和关闭路径，不是 tarball 安装                          |
| 治理与声明            | 21 项治理回归及 repository/catalog/source declaration 检查通过         | exports、实际依赖声明和 source entry；已有其他包 Tegami 名称提示不算本迁移失败                                                              |
| Services 会话生命周期 | 66 个测试文件、353 项通过                                              | 正常 bootstrap 替换、session epoch 撤回、实际 transport 的迟到 RPC 和子资源排空；最终浏览器同时验证在线 stop/start 无关闭中 socket 报错     |
| Worksplit 修复        | 目标 checkout React 19 个套件、244 项及 Core 5 项通过；类型、lint 通过 | 目标分支包含具体阻塞修复和用户上一轮菜单示例；同源本地 commit，未发布到远端 registry                                                        |
| 公开文档构建          | client/SSR/SSG 构建通过，生成 622 个文件                               | 实际文档项目构建，不以 Markdown 文本或链接检查代替                                                                                          |

当时的命令与回执保存在 `/tmp/pluxel-flexlayout-complete-tests.log`、`/tmp/pluxel-flexlayout-complete-types.log`、`/tmp/pluxel-flexlayout-complete-lint.log`、`/tmp/pluxel-flexlayout-complete-build.log`、`/tmp/pluxel-flexlayout-complete-installed.log`、`/tmp/pluxel-flexlayout-governance-complete.log` 与 `/tmp/worksplit-pluxel-target-final-tests.log`。这些是本机临时证据；重新验证以 package scripts 和对应测试为准，不依赖临时路径永久存在。Workbench 测试共 514 项；根 ordinary/type-aware lint 与 97 个变更文件的 format 检查通过。

当前 Worksplit commit 的 `test:package` 已通过 pack、npm install 和公开 JS/types/CSS 消费，记录于 `/tmp/worksplit-pluxel-complete-package.log`。该证据与 Workbench 独立目录 Vite smoke 分开；两者均不表示已发布到远端 registry。公开文档构建记录位于 `/tmp/pluxel-flexlayout-complete-docs.log`。

实际公开读取入口 `pnpm pluxel docs workbench/operations.md` 成功输出当前原生布局、publication 默认名称、F2 刷新保持与副本行为；9 个相关文档及生成 AGENTS 的 99 条本地链接检查没有缺失目标。

## 集成回归的实际保护范围

Shell 测试位于 `packages/workbench/shell/tests/`，以下文件使用实际 App、Worksplit、原生 Model 和文档生命周期。业务页面或远端传输按测试目标替换，不能把这些 fixture 说成在线 Plugin 状态。

| 回归入口                                                                                                                                                                                                                                                                   | 实际保护的契约                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [workbench-app-surface](../packages/workbench/shell/tests/workbench-app-surface.test.tsx)                                                                                                                                                                                  | 等待 committed directory 才创建 workspace；全部内置入口；独立文档 Router 和共享服务 Provider；短路由、canonical/standalone 深链；坏快照及失败重置反馈；普通 tab label/key、exact-owner canonical title、未发布 owner fallback 与原生名称复用/刷新 |
| [workbench-route-continuity](../packages/workbench/shell/tests/workbench-route-continuity.test.tsx)、[declared-route-integration](../packages/workbench/shell/tests/workbench-declared-route-integration.test.tsx)                                                         | 原生移动和工具焦点保持内容、Router 与 draft；参数路由、冲突 canonical fallback、未提交目录和未知页面；单文档错误恢复                                                                                                                              |
| [workbench-host-navigation](../packages/workbench/shell/tests/workbench-host-navigation.test.tsx)                                                                                                                                                                          | 真实生成 Bridge 与 Host facade 的 origin-document 导航；按 committed directory 离开 standalone；根/嵌套 basepath、params、结构化 search/hash；SDK 拒绝非规范路径；请求 title/meta 生效；关闭后缓存 navigation 撤销                                |
| [workbench-native-activation](../packages/workbench/shell/tests/workbench-native-activation.test.tsx)、[content-activation](../packages/workbench/shell/tests/workbench-content-activation.test.tsx)                                                                       | 真实 Content renderer 和生成 MF Bridge；每 open 独立 root；StrictMode 一次 open/subscription；主题/移动不重开；后台恢复惰性打开；晚到 open 排空；Bridge/Host/RPC 清理失败进入关闭回执                                                             |
| [workbench-close-lifecycle](../packages/workbench/shell/tests/workbench-close-lifecycle.test.tsx)                                                                                                                                                                          | 有等待点的原子批量关闭和离开工作区；后续拒绝、编辑 revision 改变、editor owner 替换、revision 能力撤回时零标签删除；保存失败保留输入；拒绝不留幽灵历史；pin/关闭保护阻止重置                                                                      |
| [workbench-native-menus](../packages/workbench/shell/tests/workbench-native-menus.test.tsx)、[shell-interactions](../packages/workbench/shell/tests/workbench-shell-interactions.test.tsx)                                                                                 | 非活动目标副本/固定、preview 提升、菜单输入与键盘、原生分隔与焦点、可见候选与完整分组、删除/移动目标后旧 callback 失效、Mantine Provider/portal 释放、溢出选择、主题及输入中的快捷键边界                                                          |
| [workbench-state-persistence](../packages/workbench/shell/tests/workbench-state-persistence.test.tsx)                                                                                                                                                                      | 新 snapshot 恢复 group/pin/geometry；不保存 draft/dirty/Router；合并写入和 StrictMode 去重；不读取旧 grid key；存储故障反馈及最新快照重试                                                                                                         |
| [workbench-outline](../packages/workbench/shell/tests/workbench-outline.test.tsx)、[workbench-config-save](../packages/workbench/shell/tests/workbench-config-save.test.tsx)、[config-form-loop](../packages/workbench/shell/tests/web/config-form-loop.test.tsx)          | 多实例配置编辑与真实保存契约；同名 Markdown/config anchors 只滚动本地文档；同 owner 副本的表单 DOM id、label 和目录目标不交叉                                                                                                                     |
| [workbench-federated-availability](../packages/workbench/shell/tests/workbench-federated-availability.test.tsx)、[session-reload](../packages/workbench/shell/tests/session-reload.test.ts)、[runtime-updates](../packages/workbench/shell/tests/runtime-updates.test.tsx) | producer 失败不伪造打开成功；会话失效采用完整 reload；普通状态/目录更新刷新权威事实                                                                                                                                                               |
| [public-surface](../packages/workbench/tests/public-surface.test.ts)、[workbench-federation](../packages/workbench/tests/workbench-federation.test.tsx)、[workbench-client](../packages/workbench/tests/workbench-client.test.ts)                                          | 公开 exports 不含 Pane Kit；生成 Bridge payload 不再传布局 renderer；每个成功结果只有一个 ownership；坏 DTO/tuple 和 closed failure 清理                                                                                                          |

## 真浏览器与在线证据

[浏览器脚本](../projects/plugin-host/dev/workbench.browser.mjs) 使用真实 `projects/plugin-host` 应用及其 ReportStudioPlugin MF 页面；[控制台函数](../projects/plugin-host/dev/workbench.ts) 执行实际 open/dispose、停止和启动。先发现既有 Vite 实例，再固定绝对 root 与 instance 提交普通 TypeScript 导出函数，未用隔离 test host 代替在线操作。

另有[真实配置草稿浏览器检查](../projects/plugin-host/dev/workbench-config.browser.mjs)与[只读配置控制台函数](../projects/plugin-host/dev/workbench-config.ts)：最终生产产物下 6 项检查通过，回执位于 `/tmp/pluxel-flexlayout-config-complete/receipt.json`，使用相同 root 与 origin，instance 为 `ee99c219-ba5d-4b57-8d25-120e6f38130d`，没有 `failure`，`errors` 与 `resourceFailures` 均为空。该脚本只编辑 draft，不执行保存。后加载 MF 的 Mantine CSS 曾将业务 Tabs.Panel 压到 20px，scoped panel 布局修复后真实浏览器复验通过；没有向浏览器注入 CSS 掩盖问题。

| 实际配置场景           | 浏览器与控制台证据                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| late MF CSS 与配置面板 | 先加载真实 MF，再打开 canonical 插件详情；1280×850 时活动 panel 为 flex、height 636，四个非活动 panel 为 display none、height 0 |
| dirty 关闭取消         | 编辑实际 ConfigForm 后请求关闭并取消；原 DOM、draft、dirty 标记与 URL 均保留                                                    |
| 文档与业务查询切换     | 切换 MF 文档及同 owner 的 config/overview 后，实际表单节点与输入保持，不重建 draft                                              |
| 同 Plugin 两个副本     | 两个不同 input 节点保留 `/status/202` 与 `/status/203` 草稿；两份各 6 个目录 anchor ID 的交集为空                               |
| 小高度与文档局部目录   | 1280×420 的拆分内容在 viewport 内；副本目录滚至 24，原实例 scrollTop 保持 15，两个 scroll host 都有实际滚动范围                 |
| 后端未发生保存         | 前后两次实际控制台配置查询完整结果相等，desired/applied revision 均为 16；不把本次 draft 检查当成保存验收                       |

同目录四张最终截图为 `01-real-close-confirm.png`、`02-real-config-retained.png`、`03-independent-real-config-copies.png` 与 `04-owned-toc-bounded-scroll.png`。该配置检查轮次实际发布的四个页面均为 shell；canonical standalone 深链另由主脚本覆盖，完整工作区带 dirty 输入离开 standalone 后取消仍无真实入口浏览器样本。

最终主回执为 `/tmp/pluxel-flexlayout-browser-healthy/receipt.json`，截图为同目录的 `light.png`、`dark-menu.png`、`narrow.png`、`unknown.png` 与 `packages-independent-inputs.png`。该轮 20 项包含先前全部 19 项及新增 Packages 只读入口，HMR 状态为“已应用”；运行在 `http://127.0.0.1:3310`，UI basepath 为 `/__pluxel/workbench`，固定 root 为本迁移 checkout 的 `projects/plugin-host`，instance 为 `af090f0a-efd6-47a6-b1eb-935c274285b2`。原 19 项回执 `/tmp/pluxel-flexlayout-browser-complete/receipt.json` 与配置 6 项回执仍属于 `ee99c219-ba5d-4b57-8d25-120e6f38130d`，没有声称在新实例重跑配置脚本。补充 UI 证据位于 `/tmp/pluxel-native-ui-review/`。下面将提案验收项映射到实际证据，不把脚本检查数量当覆盖率。

| 场景                             | 已观察或执行的证据                                                                                                                                                                   | 结果与边界                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 同 URL 重开 / 显式副本           | 首页、日志、插件与真实 MF 页面；普通重开不增标签，两个副本保留不同输入及 DOM handle                                                                                                  | 浏览器通过；集成同时断言不同 Router/资源 owner                                                               |
| Packages MF 入口                 | `/packages` 声明标题、实际业务内容、同 URL 原 DOM 复用、右侧独立副本 A/B 草稿、关闭两节点脱离并回首页；两次只读后端 snapshot 完全相等                                                | 新主浏览器通过；没有执行 Install/Remove，不扩张为包管理业务验收                                              |
| 移动 / 拆分 / 分组 / pin         | 整组鼠标拖到右侧形成两个 TabSet，拖分隔线、移动到 Border、固定/取消固定后检查原 MF DOM 和输入                                                                                        | 浏览器通过；补充 UI 操作保持同一个滚动 DOM，`scrollTop = 40`                                                 |
| 分组管理                         | 新建、名称输入、颜色、加入/移出、折叠/展开、整组鼠标拖拽                                                                                                                             | 浏览器通过；补充 UI 同时执行菜单整组拆分与移动到 Border                                                      |
| pin 与 TabGroup                  | 固定组内标签后退出组进入 pinned run；固定标签关闭项明确禁用                                                                                                                          | 浏览器通过；preview → pin 提升只有原生菜单集成证据，生产普通入口打开完整文档，未作浏览器 preview 样本        |
| Mantine 菜单                     | 浅/深色切换、分组输入与颜色、Shift+F10、Escape 焦点返回、溢出菜单选择；Provider ancestry 和卸载 portal 集成断言                                                                      | 浏览器与集成通过；补充 390px 菜单位于视口内                                                                  |
| 非活动标签右键                   | 右键非活动首页并固定，活动 MF 地址、输入与 DOM 保持                                                                                                                                  | 浏览器通过；原生菜单集成另外验证非活动副本与 preview target                                                  |
| 菜单目标已经删除或移动           | 打开菜单后删除组/移动标签，再调用保留的 callback；菜单撤销并聚焦 surviving workspace                                                                                                 | 原生 Model/React 竞态回归通过，未用自动 browser case 重演该竞态                                              |
| 批量 dirty 关闭                  | 真实编辑器注册、保存及有等待点的两个目标；后续拒绝/revision/owner/capability 变化时零删除；保存失败保留原输入；真实 ConfigForm 浏览器取消关闭保留 DOM/draft/URL                      | 原子 batch 与保存失败集成通过，实际单文档取消关闭浏览器通过；不会回滚之前已成功的业务保存                    |
| 折叠组与批量关闭                 | 折叠 Research 组后可见关闭保留隐藏成员和固定首页；刷新后关闭整个 TabSet 删除折叠组及其中 MF，其他容器的固定首页与 Studio A 保留                                                      | 浏览器通过；已观察可见关闭与完整容器关闭的不同范围，原生关闭回归另外覆盖保护和完整分组                       |
| Border 与最大化                  | 入口工具得到焦点仍保留 MF URL，显式打开已有文档揭示 Border 中目标；最大化/还原保留输入                                                                                               | 浏览器通过；390px 通过显式收起 Border 和最大化使用业务内容，不自动改写 Model                                 |
| 前进 / 后退 / 重定向 / 阻止      | 实浏览器 logs/plugins back/forward；Worksplit redirect/dirty guard；App leave 与关闭回归保留 accepted URL                                                                            | back/forward 浏览器通过；redirect/阻止完整矩阵为集成证据，未全部重演于在线浏览器                             |
| basepath / standalone / 未知地址 | 嵌套真实 basepath；unknown 深链保留 query/hash 并显示错误；canonical standalone MF 无 workspace 且忽略坏 workspace snapshot                                                          | 浏览器通过；根 basepath、短 standalone、参数和冲突 canonical 由 App/Host 集成与服务测试覆盖                  |
| Plugin 并行打开与撤回            | 两个真实 MF 页面；八轮额外副本 open/close；实际控制台 stop/start 返回 committed、stopped/running 及无该 Plugin lifecycle issue；各一次 document reload，旧输入脱离、新输入恢复默认值 | 浏览器与真实 RPC/MF 通过；最终回执没有关闭中 WebSocket 报错，晚到结果及 cleanup failure 的具体阶段由集成覆盖 |
| StrictMode / rerender / 主题     | StrictMode 真 Bridge/Content open/subscription 集成计数；浏览器切换主题与原生布局不替换 MF 输入；八轮开闭期间只创建一条 runtime session socket                                       | 集成和浏览器通过；刷新及 epoch 完整 reload 会建立新 session socket，不能按整个回执累计条数误判为泄漏         |
| snapshot 恢复与坏数据            | 真刷新前后投影 Model 的 id/type/name/pin/color/opened/weight/size 相同，手工名称保留、draft 恢复初值；坏 JSON 原样保留直到显式删除                                                   | 浏览器通过；缺 type/children、坏 group/pin 等严格准入由 Worksplit/Pluxel 回归覆盖                            |
| 存储不可用 / 显式重置            | storage get/set/reset 抛错、重试最新状态、重置失败反馈；pin/关闭保护与 dirty 决策                                                                                                    | 集成通过；浏览器执行坏 JSON 的成功显式重置，没有模拟真实磁盘配额故障                                         |
| 大量标签 / 长列表 / 小窗口       | 12 个首页副本触发原生 overflow，640×480 无 body 横向滚动；390×844 在 Border 收起、目标最大化后内容和菜单可达；八轮 MF 开闭回挂载基线                                                 | 有限样本通过；大型插件/日志列表、长期压力、浏览器 heap 和服务器 capability/订阅总量未作性能证明              |
| 浅 / 深色与错误页面              | light、dark-menu、narrow、unknown 截图；真实 native/F6/菜单焦点；补充人工 UI 复核无页面错误或资源请求失败                                                                            | 已观察范围通过；没有全平台浏览器、屏幕阅读器或触屏验收                                                       |

重复开闭的回执基线是 6 个挂载内容节点、2 个 MF 输入；每轮临时输入从 2 增至 3，关闭后回到 2，临时 DOM 脱离，原有两实例输入仍保留。挂载内容包含入口工具，不能把 6 全称为业务文档数。这证明当段挂载与连接没有增长，不等于浏览器 heap 或服务器所有 lease 的长期排空测量。

新增的真实 Packages MF 检查从 publication 的 `/packages` 入口打开，原生名称为 `Packages`、内容标题为 `Managed plugin packages`。普通重开复用原 input DOM；右侧原生副本使用不同 input，两个安装规格草稿互不影响；关闭后两个节点脱离，回到只剩首页。控制台 `packageManagerSnapshot` 的两次回执 runId 为 `564467b6-a389-4926-bb7e-d6fe6e283af1`、`7953edf6-e162-4ae7-9df9-773925007f0a`，完整 snapshot 相等、revision 均为 0、packages 为空。没有执行 Install/Remove；这证明入口、复用、副本和资源关闭，不证明包安装或卸载业务。新主回执有 5 个实际 publication，均为 shell，没有声称已逐个打开全部 5 个 MF 内容。

## 在线结果与未验证边界

在线 stop/start 的权威控制台报告均为 committed，ReportStudioPlugin 当前 stopped/running、lifecycle issues 为空。浏览器观察到两次 epoch 通知各触发完整 document reload；旧 MF 输入脱离，恢复运行后新 MF 输入为默认值。停止后的短路由已从 committed directory 撤回，页面明确显示未知地址。

早轮两个 `WebSocket is already in CLOSING or CLOSED state.` console error 由 Services session 的迟到 RPC/资源排空修复解决，正式回执为 `ok: true`、`errors: []`。

原 19＋6 项检查的实例另有 PackageManagerPlugin 因 managed store writer 占用而 start-failed。核对发现 `.writer/owner.json` 指向已退出的上一轮验证进程 PID 173093，store 路径没有 symlink；停止本次自己的 Vite，确认相关进程均已退出后，只在完全离线状态将该 `.writer` 归档到 `/tmp/pluxel-flexlayout-stale-writer-173093`，未删除业务数据或在线解除 writer。随后重启相同正式产物。新实例的固定 root 健康回执 `/tmp/pluxel-flexlayout-healthy-health.json`、runId `0f16561d-bd3e-4b56-bebc-51c7c24ddbe4` 先确认环境恢复，再执行主浏览器 20 项。生命周期后最终回执 `/tmp/pluxel-flexlayout-final-healthy-health.json`、runId `c692e448-8a0b-4c79-b1e4-8374a9ffc18f` 的 envelope 为 ok、state 为 succeeded；全部 26 个 Plugin issues 为空，其中 21 个 running、5 个按原 desired 状态 stopped，所有 desired running 的 Plugin 都 running，PackageManager 与 ReportStudio 均 running，showcase 与 Workbench HTTP 均为 200。该离线维护及复验解决了独立环境问题；没有改动生产源码，也没有把原实例的配置 6 项证据改写成在新实例重跑。

其他已明确的验证范围：

- 只验证本地 Chromium/Vite 和独立安装样本，没有验证 Safari/Firefox、触屏、屏幕阅读器、生产账户、外部平台连接或真实 S3/业务保存后的远端效果。
- 配置保存失败、批量 revision 竞态和 late RPC cleanup 使用实际生产 owner/renderer 的集成回归；没有通过在线生产数据制造这些失败。
- 在线 canonical standalone 深链已验证；工作区中带 dirty 输入离开 standalone 后取消，尚无真实浏览器样本，当前证据是 App/close/Host 导航集成。
- 12 个内置副本、八轮真实 MF 开闭和窄窗口是可达性/挂载样本，不承诺大型 catalog、长日志、长期 RSS 或性能上限。
- 全工作区类型检查与 Workbench 安装运行 smoke 不表示所有第三方完整声明都兼容。既有 Elysia/Cap’n Web 声明检查边界仍由 [Host 部署验证](HOST_DEPLOYMENT_VALIDATION.md) 维护，本迁移不新增宽泛诊断例外。

## 清理与库修复

已删除旧 Shell tabs/store/state、split/tabState/storage、WorkspaceEditorGrid、固定插件 Workbench 拓扑、Pane controls/registry、RemotePaneLayout、重复布局持久化和旧 shell 样式。无消费者的 sidebar/activity state、导航投影、target Provider、pathname/tab-id alias 也已删除。公开 Pane Kit、React exports、Context 与 Bridge pane renderer 字段一起移除；无旧格式 reader、兼容 alias 或双写。

全 `packages/`、`plugins/`、`projects/`、公开/工程文档与生成项目 AGENTS 搜索后，旧契约没有实际消费者。Studio 的 `WorkspaceController` 持有业务文件/draft/save，vendor 的独立公开 `SplitView` 属于另一个库能力；两者保留。dnd-kit 三包仍服务插件 catalog Organizer，react-store 仍服务配置表单。无消费者的 Workbench `@mantine/dates` 依赖已移除，新增的 `flexlayout-react` 是直接消费原生 Actions、菜单和 Node 的真实依赖。

Worksplit 采用官方 origin 的同源本地 commit `7726da79a8a102c69846d0e50edcbe7bca102ee5`，依赖保持相对 vendor workspace 路径。目标 `refactor/flexlayout-tanstack` 已安全 fast-forward 这些修复；原有三个示例/测试文件的字节与 README 新增示例行均保留，原有四个脏文件没有进入修复提交。迁移 checkout 的 vendor 干净，原 Pluxel vendor 脏改动未触碰。没有声称已远端发布。具体阻塞与回归为：

| 实际调用方与失败                                                                  | 最小修复与回归                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pluxel 嵌套 UI basepath 下 `router.state.location.href` 丢失公开 basepath         | integration 使用 TanStack `publicHref`；[integration.test](../vendor/split-like-vscode/packages/react/src/integration.test.ts) 验证 params/search/hash/back；Pluxel App 把内部 `to` 与 public href 分开，避免双加 basepath                                        |
| 已保存 `{ layout: {} }` 被 Model 自动补齐成默认布局                               | owning snapshot 要求明确 type/children；同文件 malformed snapshot 回归；不改变代码初始 layout 可用原生缺省值的契约                                                                                                                                                |
| 原子关闭预检期间 approved editor 的 `getCloseRevision` 消失                       | 最终预检明确拒绝 changed；[native-layout.test](../vendor/split-like-vscode/packages/react/src/native-layout.test.ts) 与真实 Pluxel editor capability 撤回回归                                                                                                     |
| 原生 F6 handler 收不到 Worksplit portal 内容输入的 keydown                        | 仅把当前 native panel 指定的 focus-toggle 键转交原生处理；[content-keyboard](../vendor/split-like-vscode/packages/react/src/workbench-content-keyboard.test.tsx) 比较裸 Layout、停靠后内容与自定义/禁用键位，其他输入键不转交                                     |
| native F2 名称在 snapshot active/lazy restore 或同 identity 导航时被 resolve 覆盖 | 原生 Model name 保持唯一标题事实；[native-title-ownership](../vendor/split-like-vscode/packages/react/src/native-title-ownership.test.ts) 验证 restore、view search/hash/reload、晚到 load 和真正 owner/params/identitySearch 改变；真实浏览器刷新保留 Studio A/B |
| 普通文档与显式同 URL 副本在 reload/restore 被误判 native identity 冲突            | 仅对实际 navigation identity 变化作 collision 检查；[native-title-ownership](../vendor/split-like-vscode/packages/react/src/native-title-ownership.test.ts) 的真实 Router 普通文档与副本回归，保留已有 native identity 保护                                       |

这些修复沿用现有公开 API，没有为未来能力新增 wrapper、菜单 DSL、adapter 或 Plugin 协议。Pluxel 的公开删除与用户可见变化记录于 [Tegami](../.tegami/workbench-native-flexlayout.md)，版本及 publish-lock 留给发布工具管理。
