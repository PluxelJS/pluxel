---
name: pluxel-development
description: 开发、修改或排查 Pluxel 应用与插件；选择源码查询、隔离测试、开发服务日志和现有 Vite 控制台。框架维护另读仓库工程入口。
---

# Pluxel 开发

先读项目 `AGENTS.md`、目标包 scripts 与已安装版本。已知文件或符号直接查源码；需要确认 Plugin/Part 声明和应用绑定时用 inspect。只展开本次任务所需章节。

## 入口与职责

- 在项目根调用 CLI：下游用 `vp exec pluxel …`，Pluxel 源码仓库用 `vp run pluxel …`。首次 checkout 或启动器报告 CLI 过期时，先运行 `vp run @pluxel/cli#compile`。
- Plugin/Part 拥有业务与声明；Host 拥有装配、配置输入和服务安装；Vite 拥有开发期执行与 HMR。Core 自带 `events/logger/effects`，Database、Vault、Workbench 等服务需要应用安装。
- 默认工作区由 mise 提供工具和环境，package scripts 提供操作入口，Vite+ 管任务与缓存，hk 管提交检查，Pitchfork 管托管进程；Pluxel 也支持前台命令和手动 Vite。

正文优先读项目 `docs/pluxel/`，源码仓库则读 `docs/`；下表路径相对该目录。`pluxel docs <path>` 输出当前来源正文。入口缺失或源码来源不明时读 `development/source-workspaces.md`，按 Git/npm 接入方式修复，不复制另一版本文档。

## 按任务选正文

| 任务                                    | 读取入口与使用边界                                                                                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 修改 Plugin/Part                        | `plugin-development/index.md` 选对应主题；公共契约、失败、并发或取消先读 `plugin-development/contracts.md`，可恢复失败再读 `plugin-development/better-result.md` |
| 装配应用或服务                          | `host/configuration.md`；扩展服务读 `host/services.md`，不要混用生产应用、独立 Host 与 test host API                                                             |
| 查声明、配置绑定与源码位置              | `development/inspection.md`；定向请求所需 sections，显式选择 application；先检查 complete/partial/unavailable，缺口不等于不存在                                  |
| 验证插件依赖、配置或生命周期            | `plugin-development/testing.md`；使用真实 lowering 的 `@pluxel/test`，显式安装所需服务并释放 test host；普通函数用普通测试                                       |
| 操作运行中的应用                        | `development/dev-console.md`；使用现有 Vite 控制台，隔离 host 不能证明在线状态                                                                                   |
| 安装工具、管理服务或修改任务缓存/hk/Pkl | `development/workspace-toolchain.md`；先看现有配置与服务                                                                                                         |
| 源码联调、安装、catalog 或开发文档接入  | `development/source-workspaces.md`；source doctor 不证明构建产物最新，按需 source build                                                                          |
| CLI、构建/HMR、包导出或发布             | `development/tooling.md`、`development/plugin-package.md`；跨包职责查 `reference/package-matrix.md`                                                              |

框架内部维护按仓库 `AGENTS.md` → `engineering/README.md` 选择领域。表格是路由，不是通读清单；已明确契约、所有者、调用方和验证方式后开始修改。

## 需要运行应用时

先读 `package.json` 的 `pluxel.dev` 并运行 `pluxel dev status`。profile 选择顺序：显式 `--profile` → `default` → 唯一 profile；跨目录用 `--root` 指定配置查找起点。多个匹配实例用 `dev instances` 后明确 `--instance`，不猜最近进程。

确需启动时用项目 `vp run dev`：已有实例会再次显示实际地址。`command` 保持前台，Ctrl+C 停止；Pitchfork 启动就绪后返回，停止/完整重启用 `pitchfork stop/restart <service>`。`console: false` 是没有 Pluxel 控制台的托管服务，只查服务状态，不执行 console 操作。

使用 Pitchfork 时先读 `pitchfork.toml` 并核对完整服务 ID；实际 URL 从服务或 `dev` 输出取得。已注册服务可由访问 URL 唤起；HTTP 响应和进程 running 不代表应用 ready。`pitchfork wait` 等待停止，不能用来等待就绪。启动、编译和进程故障先读有界日志：

```sh
pitchfork logs <service> --since 5min -n 100 --no-pager
```

`--follow` 仅用于短时观察。普通源码更新交给 HMR，单个 Plugin 重启用 console/Workbench；进程环境变化才完整重启服务。并行 worktree 隔离 namespace 与数据目录，只停止本任务拥有的服务。新增进程监督、端口扫描或轮询前，查工作区指南与已安装 Pitchfork 的帮助。

## 在线操作与交付

执行前读控制台指南，用同一 profile 核对 `application.state` 和 `latestUpdate`，在其 Vite root 内写 `defineDevConsole` TypeScript 操作。文件参数相对终端当前目录，`--root` 不改变文件基准。源码仓库已有只读入口：

```sh
vp run pluxel dev status
vp run pluxel dev run projects/plugin-host/dev/inspect.ts
```

- 配置、Plugin 方法/生命周期、Workbench RPC 和业务日志都通过现有控制台；每次取得当前 handle，await 操作，释放自建资源，不重开应用数据库。
- 检查退出码、run state、领域结果、apply report 和相关日志。配置保存或 CLI 成功不等于运行实例已采用修改。
- 保存 `receipt`；超时或 `outcome_unknown` 先用 `dev result RECEIPT` 查询，取消用 `dev cancel RECEIPT`。两者不附带目标参数，始终绑定原实例；不因重启而重投写操作，取消不回滚已提交变更。

按改动风险运行目标 scripts 和相应隔离/在线验证；不要为纯函数测试启动应用，也不通过关闭 lowering 或 lint 让检查通过。交付说明实际结果及未验证边界，用法变化同步所属文档。
