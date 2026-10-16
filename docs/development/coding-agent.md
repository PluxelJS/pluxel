---
title: Coding agent 开发指南
description: 从接手任务、复用开发服务到在线操作和交付，给 coding agent 的实际工作路径。
---

这页面向在 Pluxel 项目中读代码、修改插件和排查运行状态的 coding agent，也方便开发者检查 agent 是否使用了正确入口。先读项目自己的 `AGENTS.md`；本页提供工作路径，项目约束和当前安装版本决定具体命令与契约。

## 1. 接手任务：先确定项目和证据

读取目标包的 `package.json`、相关配置和现有改动，确认任务属于应用/插件开发还是框架维护。已有明确文件和符号时直接用 `rg` 与源码，不为走流程扫描整个仓库。

- 应用/插件：读取 `.agents/skills/pluxel-development/SKILL.md`，按主题进入[插件开发范式](../plugin-development/index.md)或 [Host 配置](../host/configuration.md)。
- 框架维护：从仓库 `AGENTS.md` 进入对应工程文档，核对 exports、实现和已知调用方。
- 文档来源：下游执行 `vp exec pluxel docs development/coding-agent.md`，或读取 setup 后的 `docs/pluxel/`；源码仓库直接读 `docs/`。入口缺失按[源码工作区](./source-workspaces.md)恢复，不复制另一版本的文档。

修改前明确：谁提供输入、谁拥有状态和资源、谁消费结果、怎样证明修改生效。静态声明用 [inspect](./inspection.md)，类型与构建用项目 scripts，插件行为用[隔离测试](../plugin-development/testing.md)，当前运行状态用 [dev console](./dev-console.md)。这些证据不能相互替代。

## 2. 准备工作区：用已有入口

先检查 `mise.toml`、`package.json`、`vite.config.ts`、`hk.pkl`；需要服务时再读 `pitchfork.toml`。工具版本归 mise，操作入口归 scripts，任务依赖和缓存归 Vite+，检查归 hk，服务进程归 Pitchfork。不要为同一命令再加一层包装。

| 操作 | Pluxel 源码仓库 | create 生成的应用 | 独立插件模板 |
| --- | --- | --- | --- |
| 首次准备工具与依赖 | `mise trust`、`mise install`、`vp install` | 同左，再 `vp run setup` | 同左，再 `vp run setup` |
| 安装提交 hooks（已有 Git） | `vp run hooks:install` | 同左 | 同左 |
| 启动开发应用 | `vp run dev`（`plugin-host`） | `vp run dev`（`app`） | 无独立应用服务 |
| 构建 / 测试 | `vp run build` / `vp run test` | 同左 | 同左 |
| 完整项目检查入口 | `vp run verify` | 同左 | 同左 |
| 执行 Pluxel CLI | `vp run pluxel …` | `vp exec pluxel …` | `vp exec pluxel …` |

表格描述当前模板，已有项目以实际 scripts 为准。`verify` 的覆盖范围由该项目任务图定义，不能据名称推断检查了所有包。优先选择与改动相关的检查；用户明确跳过检查时，在交付中记录未验证边界。缓存、依赖操作、Pkl 与工具配置见[工作区工具链](./workspace-toolchain.md)。

## 3. 需要运行应用：先发现，再复用

先运行 `pitchfork list --json`，核对项目、namespace 和完整服务 ID。以下以源码仓库 `plugin-host` 为例；生成应用使用 `app`，跨目录或 worktree 使用发现的完整 ID。

```sh
pitchfork status plugin-host --json
# 确认需要启动时执行；已有运行服务会复用
vp run dev
# 获取启动与编译诊断；不要默认持续订阅日志
pitchfork logs plugin-host --since 5min -n 100 --no-pager
```

使用 Pitchfork 返回的实际代理地址，不拼接服务名或猜域名。已注册项目可通过 URL 唤起服务，但首次 checkout 仍需准备依赖并注册或启动；代理启动页、HTTP 响应或进程 running 都不证明 Pluxel 应用 ready。按[服务与反代指南](./workspace-toolchain.md#管理开发服务)确认启动结果。

`start` 等待就绪后返回，服务继续由 Pitchfork 管理；再次 `dev` 会复用它。`pitchfork wait` 等待停止，不能当作等待就绪。并行 worktree 保留独立 namespace 和数据目录，只操作本任务所属服务。

## 4. 操作运行中的应用：固定 root 与 instance

Vite root 不一定等于仓库根或应用声明目录。先发现实例：

```sh
# Pluxel 源码仓库
vp run pluxel dev instances --root projects/plugin-host

# create 生成的应用：替换为本项目绝对路径
vp exec pluxel dev instances --root /absolute/my-app/host/web
```

核对返回的 `root`、`pid`、`instanceId` 和 `application.state`。`updating` 表示正在接纳修改，`unavailable` 时先看 `application.latestUpdate`；只有进程存在不能视为应用成功。

后续操作固定发现的**绝对 root 与准确 instanceId**。按[控制台指南](./dev-console.md)创建普通 TypeScript 导出函数，通过 `dev run` 执行；脚本放在实际 Vite root 内，命令中的脚本路径从终端当前目录解析，`--root` 不会改变当前目录。配置修改、Plugin 方法、生命周期、Workbench RPC 和业务日志都走现有实例的控制台。

每次检查操作结果、领域/应用报告与相关日志。超时保留 `runId` 并查询原结果；`outcome_unknown` 不表示未发生写入，不能盲目重放。进程重启后重新发现实例，热更新后重新取得运行对象。完整调用示例、结果查询和资源清理契约只维护在[控制台指南](./dev-console.md)。

## 5. 排障：在拥有问题的层处理

| 现象或需求 | 处理入口 | 成功依据 |
| --- | --- | --- |
| 启动失败、编译报错、进程退出 | Pitchfork 有限窗口日志；检查启动配置与源码 | 新启动结果及错误已消除 |
| URL 返回启动页或 502 | Pitchfork 状态、日志和实际代理 URL | 服务就绪，再检查应用状态 |
| 应用未接纳修改 | dev console 的 `application.latestUpdate` 与相关报告 | 新版本接纳与预期业务结果 |
| 查看 Plugin 业务日志、配置或调用方法 | 固定 root/instance 的 dev console | 操作回执、报告和相关日志 |
| 普通源码修改 | 优先让 Vite HMR 处理 | 修改被接纳，目标行为符合预期 |
| 只需重启某个 Plugin | 现有 console 的 `dev.plugins.restart` 或 Workbench Plugin 操作 | Plugin 生命周期报告与业务结果 |
| 修改进程环境、需完整重启或进程已失效 | `pitchfork restart plugin-host`（模板为 `app`） | 重新发现实例并检查应用状态 |
| 结束本任务启动的临时服务 | `pitchfork stop plugin-host`（模板为 `app`） | 服务停止；之后访问 URL 仍可能再次唤起 |

不要添加自制后台进程、端口扫描、无限轮询或自动重试来掩盖失败。先查[工作区指南的官方能力链接](./workspace-toolchain.md)及已安装 CLI 帮助。`logs --follow` 只用于有目的的短时观察；退出日志订阅不会停止服务。保留其他任务或开发者正在使用的共享实例。

## 6. 交付：说清改动与实际证据

同步已知调用方和用户文档；删除契约后搜索旧入口，涉及生成项目时同步模板。按项目规则记录公开包变更。提交、推送和服务清理由当前任务授权决定。

交付说明至少回答：改了什么、执行了哪些检查、观察到什么结果、哪些边界未验证。在线任务记录实例与观察结果；测试通过不代表运行实例已更新，日志中没有匹配到 error 也不能单独证明成功。
