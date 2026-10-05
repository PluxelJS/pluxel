---
name: pluxel-development
description: 开发、修改和排查 Pluxel 应用或插件时使用，优先利用源码 inspect、静态检查、官方插件测试和现有 Vite dev console 验证修改。纯业务函数按普通测试处理；框架内部维护另读仓库工程入口。
---

# Pluxel 开发

优先使用 Pluxel 提供的结构化查询与验证能力。先确认项目根、目标包/应用、已安装版本和 package scripts；只查询本次任务需要的范围。用户任务与项目 AGENTS 约束决定操作范围。

## 先选能力

| 要解决的问题                                | 首选入口                                   | 执行要求                                                       |
| ------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| Plugin、Part、依赖、schema 或配置输入在哪里 | `@pluxel/rolldown/inspect`                 | 定位声明、归属与源码位置；应用输入显式选择 `application`       |
| 类型、lint、包声明或构建是否正确            | 项目 scripts、`pluxel workspace doctor`    | 执行实际检查；inspect 的 `checks` 只列脚本，不执行             |
| 插件行为、配置、依赖或清理是否符合契约      | `@pluxel/test/vitest` + `@pluxel/test`     | 用真实 lowering 与隔离 host 验证相关成功、失败和清理路径       |
| 运行中的应用是否采用修改、调用是否生效      | `pluxel dev` + `@pluxel/host-vite/console` | 发现现有实例，固定 root/instance，核对运行结果、领域报告与日志 |
| 跨仓库源码解析或工具产物有问题              | `pluxel source`                            | 按源码工作区文档检查 overlay，按需构建精确 package             |

已知文件和声明时直接读源码；普通函数与任意 import 用 `rg`。不为局部修改扫描全仓库，也不为纯业务计算启动插件 host。

## 按需读文档

使用源码 overlay 时，先用 `pluxel source` 查看本项目选择的 checkout 与包；`pluxel source list` 查看可用登记。Git CLI 所属 checkout 是 Pluxel 来源；先确认 setup/doctor 通过，再读 `docs/pluxel/`。读取正文也可运行：

```sh
pnpm exec pluxel docs development/index.md
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

先看所属包和根项目的 scripts。模板项目完成修改后运行 `pnpm verify`；其他项目执行实际声明的相关检查。静态类型、lint、构建与运行测试各自提供证据，不能互相代替；不得通过关闭 lowering 或绕过 Pluxel lint 规则让检查假通过。

修改插件运行行为时，运行相关回归；已有覆盖不足时增加最小有意义的测试。使用 `@pluxel/test/vitest` 与 `createTestHost()`，显式选择服务并用 `await using` 回收。直接 `new Plugin()` 或 mock Context 不能证明依赖注入、配置与生命周期正确。

按风险选择边界：纯计算用单元测试；Plugin 配置、依赖和资源释放用 test host；页面交互用浏览器测试；真实监听器行为与发行入口分别用 listener 和 artifact smoke。检查实际执行的用例，脚本成功但未覆盖本次行为不能算验证完成。

源码 overlay 下，Vitest config 需要 artifact 时使用 `pluxel source build --package @pluxel/test`；inspect 工具需要 artifact 时选择 `@pluxel/rolldown`。不要以内部源码 import 或全局 conditions 绕过 bootstrap，详情见源码工作区文档。

## dev console：验证实际生效

修复正在运行的应用问题，或任务要求确认配置、调用、HMR 的实际效果时，主动使用控制台。先读 `development/dev-console.md`，检查现有 Vite 配置与进程，再发现实例：

```sh
pnpm exec pluxel dev instances --root /absolute/vite-root
pnpm exec pluxel dev run dev/check.ts --root /absolute/vite-root --instance INSTANCE_ID
```

把示例 root 和 instance 换成发现的真实值；入口脚本位于所选 Vite root 内，CLI 脚本路径相对命令当前目录。使用 `defineDevConsole` 定义普通 TypeScript 导出函数，在函数内执行操作，返回有界 JSON 数据。

- 复用现有实例；确认 `application.state` 与最近更新，进程存在不代表应用 ready。未启用时按项目需要配置 `devConsole: true`，使用项目原有 dev 命令；无可用实例时明确报告在线验证缺口，不用隔离 host 冒充。
- 后续 `run/result/cancel` 固定相同绝对 `--root` 与准确 `--instance`。配置、Plugin 方法、生命周期、Workbench RPC、数据及日志操作通过该控制台执行。
- 检查退出码、run state、业务返回值、应用/生命周期报告和相关日志；CLI 成功不等于业务成功，保存配置不等于已应用。
- 每次取得当前 Plugin/service handle；await 操作，释放脚本创建的资源。控制台借用现有 host，不重开其数据库，不创建替代 runtime 推断在线状态。
- 写操作须属于用户任务范围。超时或 `outcome_unknown` 时用原 runId 查询结果，不直接重放；取消不回滚已提交变更。

具体配置、日志游标、RPC 资源与取消契约以控制台文档及所用服务 API 为准。控制台证明在线效果，隔离测试保护可重复回归；涉及这两种目标时都要验证。

## 交付证据

说明修改了什么，列出实际运行的相关检查及结果。在线验证标明目标 root/instance 与实际观察到的状态；未验证的边界说明原因。公共用法变化同步文档和示例，不把提案、历史记录或工具执行成功当作契约证据。
