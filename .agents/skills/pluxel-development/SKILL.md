---
name: pluxel-development
description: 开发、修改和排查 Pluxel 应用或插件时使用；指导工作区入口、开发服务与日志、源码 inspect、隔离测试和现有 Vite dev console 在线操作。纯业务函数按普通测试处理；框架内部维护另读仓库工程入口。
---

# Pluxel 开发

优先使用 Pluxel 提供的结构化查询与验证能力。先确认项目根、目标包/应用、已安装版本和 package scripts；只查询本次任务需要的范围。用户任务与项目 AGENTS 约束决定操作范围。

## 工作区与开发服务

先读取项目 `AGENTS.md` 和目标包 scripts。源码仓库通过 `vp run pluxel …` 调用 CLI；生成的应用和独立插件通过 `vp exec pluxel …`。下文 CLI 示例使用下游入口，源码仓库替换前缀即可。

首次准备使用 `mise trust`、`mise install`、`vp install`；源码 checkout 首次使用 `dev` 前运行 `vp run @pluxel/cli#compile`，之后仅在启动器提示 CLI 过期时重建；模板项目再执行 `vp run setup`，已有 Git 仓库按需执行 `vp run hooks:install`。已有工作区先确认状态，不在每次任务开始时重复安装或 setup。

工具版本与环境由 mise 提供，日常操作从 package scripts 发现，任务依赖与缓存由 Vite+ 管理。修改这些配置时读 `development/workspace-toolchain.md`；不要添加重复的任务包装。

**只有需要运行应用或排查服务时才执行以下流程。** 独立插件模板没有应用服务，不为纯插件测试额外启动 Host。

1. 读取 `package.json` 的 `pluxel.dev`：名称直接对应 profile 配置。每个 profile 的 `root` 相对声明目录，默认 `.`；`command` 启动前台命令，`pitchfork` 选择托管服务，必须且只能选择一个。源码仓库为 `plugin-host: {root: projects/plugin-host, pitchfork: plugin-host}`，create 模板为 `app: {root: host/web, pitchfork: app}`。一个 package 可以有多个 profile，目录可相同或不同；选择顺序为显式 `--profile`、`pluxel.dev.default`、唯一 profile；`default` 必须指向已声明名称。跨目录用 `--root` 选择配置发现起点，不绕过已发现配置。
2. 用 `pluxel dev status` 检查 profile 的实例与应用状态。启用控制台的 profile 默认 `console: true`，其 `status/run/instances` 不调用 Pitchfork、不自动启动；按 Vite root 与启动归属筛选后，唯一实例自动选中，多个时用 `--instance`，不选最近启动的进程。需要启动时用 `vp run dev`（`pluxel dev`）：复用已有实例时再次显示实际 Application / Workbench 地址。普通 `command` 保持前台，Ctrl+C 停止；Pitchfork 启动等待就绪后返回，服务继续在后台运行，不强制重启。
3. **项目使用 Pitchfork 时**先读 `pitchfork.toml`，核对服务状态与完整 ID。从 Pitchfork 返回值读取实际代理 URL，不拼域名。已注册项目可通过访问 URL 唤起服务及依赖；首次 checkout 仍需准备依赖并注册或启动。代理启动页、HTTP 响应或进程 running 不代表应用 ready，随后按下方 dev console 流程确认应用状态。`pitchfork wait` 等待停止，不用于等待就绪。
4. Pitchfork 的启动失败、编译错误、进程退出及 stdout/stderr 使用有限窗口日志：

   ```sh
   pitchfork logs <service> --since 5min -n 100 --no-pager
   ```

   只为有目的的短时观察使用 `--follow`；退出订阅不会停止服务。前台命令直接查看所在终端。Plugin 业务日志、配置和方法调用使用 dev console，不以进程日志代替应用报告。

模板 `app` 是默认托管 profile，`vp run dev:local` 选择同 root 的前台 `local`，后续控制台命令也加 `--profile local`。文档站等没有 Pluxel Host 的服务使用 Pitchfork profile 的 `console: false`；本仓库 `vp run docs` 选择此类 `docs`。它的启动和 status 显示 Pitchfork 当前状态与实际 URL，不能执行控制台 run/instances 或使用 `--instance`。不要把服务就绪当作应用报告。

使用 Pitchfork 的项目按失败所属层处理重启：

| 需要处理的变化             | 操作                                                           | 随后确认                                  |
| -------------------------- | -------------------------------------------------------------- | ----------------------------------------- |
| 普通源码修改               | 交给 Vite HMR                                                  | `application.latestUpdate` 与目标业务结果 |
| 单个 Plugin 的生命周期     | 现有 console 的 `dev.plugins.restart` 或 Workbench Plugin 操作 | 生命周期报告与业务结果                    |
| 进程环境变化或完整服务重启 | `pitchfork restart <service>`                                  | 重新查询目标状态；旧 receipt 仍绑定原实例 |
| 结束本任务启动的临时服务   | `pitchfork stop <service>`                                     | 服务停止；之后访问 URL 仍可能唤起         |

使用 Pitchfork 的工作区为并行 worktree 保留独立 namespace 与数据目录，只操作本任务所属服务，保留原有共享实例。新增后台进程、端口扫描、轮询、重试或生命周期脚本前，先查工作区指南链接的官方能力与 `pitchfork <command> --help`。

## 先选能力

| 要解决的问题                                | 首选入口                                   | 执行要求                                                 |
| ------------------------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| Plugin、Part、依赖、schema 或配置输入在哪里 | `@pluxel/rolldown/inspect`                 | 定位声明、归属与源码位置；应用输入显式选择 `application` |
| 类型、lint、包声明或构建是否正确            | 项目 scripts、`pluxel workspace doctor`    | 执行实际检查；inspect 的 `checks` 只列脚本，不执行       |
| 插件行为、配置、依赖或清理是否符合契约      | `@pluxel/test/vitest` + `@pluxel/test`     | 用真实 lowering 与隔离 host 验证相关成功、失败和清理路径 |
| 运行中的应用是否采用修改、调用是否生效      | `pluxel dev` + `@pluxel/host-vite/console` | 选择项目 profile 与实例，核对运行结果、领域报告与日志    |
| 跨仓库源码解析或工具产物有问题              | `pluxel source`                            | 按源码工作区文档检查 overlay，按需构建精确 package       |

已知文件和声明时直接读源码；普通函数与任意 import 用 `rg`。不为局部修改扫描全仓库，也不为纯业务计算启动插件 host。

## 按需读文档

使用源码 overlay 时，先用 `pluxel source` 查看本项目选择的 checkout 与包；`pluxel source list` 查看可用登记。Git CLI 所属 checkout 是 Pluxel 来源；先确认 setup/doctor 通过，再读 `docs/pluxel/`。读取正文也可运行：

```sh
vp exec pluxel docs development/index.md
```

**该命令输出文档正文及来源。** 优先读工作区 `docs/pluxel/`；入口缺失时 Git 用户执行上游 CLI 的 `source install`，npm 用户安装依赖后执行 `workspace setup`。不要手工复制正文或改链接；文档仍需与实际 exports、类型和调用方核对。

下表路径相对 `docs/`；可传给 `pluxel docs <path>`。直接阅读的入口是 [公开文档](https://github.com/PluxelJS/pluxel/blob/main/docs/development/index.md)。先满足项目必读约束，再只展开涉及的章节，不递归通读所有链接。

先按所有者选正文：Plugin/Part 业务读 `plugin-development/`；应用安装、部署输入与输出读 `host/configuration.md` 的对应章节；工具和验证读 `development/`。只改插件日志时不要读取 Host exporter 配置，只改 Host sink 时不要重读插件写法。

| 当前任务                                   | 文档路径                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 不确定插件应采用什么范式                   | `plugin-development/index.md`：按任务选一页                                                             |
| 插件依赖 / 事件通知 / 日志                 | `plugin-development/model.md`、`plugin-development/events.md`、`plugin-development/logging.md`          |
| 资源与清理 / 配置 / Part                   | `plugin-development/lifecycle.md`、`plugin-development/configuration.md`、`plugin-development/parts.md` |
| API 与错误恢复                             | `plugin-development/contracts.md`、`plugin-development/better-result.md`                                |
| 独立并发与取消工具                         | `plugin-development/async.md`                                                                           |
| HTTP / 命令 / 数据库 / 凭据 / worker       | `plugin-development/` 下对应能力页，索引列出准确路径                                                    |
| 应用装配、配置来源、持久化、日志输出、部署 | `host/configuration.md`：直接定位章节                                                                   |
| 自定义服务安装器或管理入口                 | `host/services.md`、`host/management.md`                                                                |
| 源码声明 / 隔离回归 / 在线操作             | `development/inspection.md` / `plugin-development/testing.md` / `development/dev-console.md`            |
| 工具、任务缓存、hk/Pkl 与开发服务          | `development/workspace-toolchain.md`                                                                    |
| CLI、源码联调与发布                        | `development/tooling.md`、`development/source-workspaces.md`、`development/plugin-package.md`           |
| import 入口与包职责                        | `reference/package-matrix.md`                                                                           |

Core 自带 events/logger/effects，依赖、配置和 Part 属于插件基础；HTTP、Vault、Database、worker、Workbench 需按项目装配，不把 preset 默认安装当作任意 Context 的保证。

插件测试属于基本功；实现前选择测试边界。涉及公开方法、失败处理、并发或取消时，先读对应设计原则，不等故障出现才查。

示例先区分生产应用声明、独立 `createHost()` 与 `createTestHost()`；不要把测试的 `host.start(Plugin, ...)` 放进生产入口。Better Result 的选择与传输边界只在对应指南维护。

确认改动位置、权威输入、受影响调用方和验证方式后开始实现；出现契约冲突再补查。Pluxel 框架内部维护转到其仓库 `AGENTS.md` 与 `engineering/README.md`。

## inspect：定位权威声明

先读 `development/inspection.md`。在项目依赖中确认 `@pluxel/rolldown`，从公开子路径导入 `openProject`，用 `await using` 释放 project。查询不启动应用、不执行 Plugin 或 schema 工厂。

- 已知包：`plugins({ packageName })`，使用返回的 `definition` 调用 `plugin()`；不要猜身份。
- 已知文件：`file(path)`；项目结构未知才用 `overview()`。
- `include` 只请求所需的 `parts/config/dependencies/inputs/checks`；修改 env、file 或初始配置时显式传 `application: { root, entry }`，路径基准见文档。
- 先读 `complete / partial / unavailable` 和 gaps，再使用事实。空结果或缺口不能证明不存在，也不能证明运行配置。
- 修改已查询的声明后重查相关 section，确认位置与关系；普通源码搜索仍用于分析任意 import 的影响。

## 静态检查与隔离回归

先看所属包的 scripts 与根 `vite.config.ts` 的原生 tasks。模板项目使用 `vp run verify` 作为完整检查入口；按改动风险和用户要求选择实际检查范围，其他项目执行实际声明的相关检查。不要从脚本名称推断覆盖范围；用户明确跳过检查时记录未验证边界。静态类型、lint、构建与运行测试各自提供证据，不能互相代替；不得通过关闭 lowering 或绕过 Pluxel lint 规则让检查假通过。

修改插件运行行为时，运行相关回归；已有覆盖不足时增加最小有意义的测试。使用 `@pluxel/test/vitest` 与 `createTestHost()`，显式选择服务并用 `await using` 回收。直接 `new Plugin()` 或 mock Context 不能证明依赖注入、配置与生命周期正确。

按风险选择边界：纯计算用单元测试；Plugin 配置、依赖和资源释放用 test host；页面交互用浏览器测试；真实监听器行为与发行入口分别用 listener 和 artifact smoke。检查实际执行的用例，脚本成功但未覆盖本次行为不能算验证完成。

源码 overlay 下，Vitest config 需要 artifact 时使用 `pluxel source build --package @pluxel/test`；inspect 工具需要 artifact 时选择 `@pluxel/rolldown`。不要以内部源码 import 或全局 conditions 绕过 bootstrap，详情见源码工作区文档。

## dev console：验证实际生效

修复正在运行的应用问题，或任务要求确认配置、调用、HMR 的实际效果时，主动使用控制台。先读 `development/dev-console.md`，按项目配置连接现有实例：

```sh
vp exec pluxel dev status
vp exec pluxel dev run host/web/dev/check.ts
# 跨目录操作：配置与脚本路径分别显式指定
vp exec pluxel dev status --root /absolute/app-package --profile app
vp exec pluxel dev run /absolute/app-package/host/web/dev/check.ts --root /absolute/app-package --profile app
```

源码仓库用 `vp run pluxel dev run projects/plugin-host/dev/inspect.ts`。模板 Vite root 是 `host/web`，应用声明目录则是 `host`；脚本必须位于目标 Vite root 内，CLI 文件路径相对终端当前目录，`--root` 不改变此基准。用 `defineDevConsole` 定义普通 TypeScript 导出函数，在函数内操作并返回有界 JSON。

- 确认 `application.state` 与最近更新；`updating` / `unavailable` 时读 `application.latestUpdate`，进程 running 不能代替应用 ready。未启用控制台时按项目需要配置 `devConsole: true`。无可用实例时报告在线验证缺口，不用隔离 host 冒充。
- 按 profile 核对实例归属：前台命令由 CLI 自动传入 `PLUXEL_DEV_PROJECT` / `PLUXEL_DEV_PROFILE`，按声明 package 的真实目录、profile 名和 Vite root 核对，不手配这些环境变量；Pitchfork profile 匹配控制台捕获的短服务名。多个匹配实例用 `dev instances` 查看后加 `--instance`，不能用它绕过 profile 筛选。没有 profile 配置时，控制台使用最近 package 根目录或显式 `--root` 的目录连接手动 Vite；声明了配置就必须遵守配置。
- 配置、Plugin 方法、生命周期、Workbench RPC、数据和应用业务日志通过控制台执行。检查退出码、run state、领域返回值、应用/生命周期报告及相关日志；CLI 成功不等于业务成功。
- 每次取得当前 Plugin/service handle；await 操作，释放脚本创建的资源。控制台借用现有 host，不重开其数据库，不创建替代 runtime 推断在线状态。
- 保存输出的 `receipt`。超时或 `outcome_unknown` 时执行 `pluxel dev result RECEIPT`，取消用 `pluxel dev cancel RECEIPT`，均不再附带目标选择参数。receipt 固定原实例；进程重启后不会转投新实例。raw runId 只是诊断，不直接重放写操作；取消不回滚已提交变更。

具体配置、日志游标、RPC 资源与取消契约以控制台文档及所用服务 API 为准。控制台证明在线效果，隔离测试保护可重复回归；涉及这两种目标时都要验证。

## 交付证据

说明修改了什么，列出实际运行的相关检查及结果。在线验证标明 profile、Vite root、实际服务/实例与观察到的状态；未验证的边界说明原因。公共用法变化同步文档和示例，不把提案、历史记录或工具执行成功当作契约证据。
