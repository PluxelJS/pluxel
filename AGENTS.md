# Coding agent 工作入口

应用/插件开发与在线排障使用 [pluxel-development skill](.agents/skills/pluxel-development/SKILL.md)；框架维护按下表选工程文档。已知文件直接定位，不为局部改动通读全部文档。

**首要目标：契约可读、行为可观测、修复可审查。** 权威输入必须明确；显式维护工具可以修复契约，运行时不得暗中改写错误输入以伪装成功，见[工程原则](engineering/DESIGN_PRINCIPLES.md#首要目标契约可读行为可观测修复可审查)。

## 按任务读取

| 任务                                             | 必读入口                                                                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 工作区工具、提交检查、开发服务                   | [工作区工具链](docs/development/workspace-toolchain.md)；检查涉及的 mise.toml、vite.config.ts、hk.pkl、pitchfork.toml 与已有服务    |
| 插件业务、配置、日志                             | [插件开发](docs/plugin-development/index.md)选择目标主题                                                                            |
| 应用装配、部署、服务扩展                         | [Host 配置](docs/host/configuration.md)对应章节，扩展再读 host/services                                                             |
| Workbench 导航、布局或视觉                       | [交互设计](engineering/WORKBENCH_DESIGN.md)、[Frontend](engineering/FRONTEND.md)                                                    |
| 文档编写与组织                                   | [文档职责](engineering/DOCUMENTATION.md)                                                                                            |
| 框架、Context、生命周期、工具链或包边界          | [工程原则](engineering/DESIGN_PRINCIPLES.md)、[系统边界](engineering/PLUGIN_SYSTEM.md)，再从[工程索引](engineering/README.md)选领域 |
| 公共 API、配置、类型、错误、扩展点或资源生命周期 | [API 设计规则](.agents/rules/library-api-design.md)的执行方式、硬约束及对应规则；检查 exports 与真实调用方                          |
| 本地 Plugin 可恢复失败                           | [Better Result](docs/plugin-development/better-result.md)；保留原生 SDK、判定、回执和生命周期失败契约                               |
| 在线操作                                         | [开发控制台](docs/development/dev-console.md)                                                                                       |
| 隔离回归                                         | [插件测试](docs/plugin-development/testing.md)；测试设施内部读[工程测试](engineering/TESTING.md)                                    |

先满足本任务必读约束，链接按相关性展开，未变化的文档不重读。明确修改点、契约、所有者、调用方和验证方式后开始实现；事实冲突或未知跨域影响再补查。普通查找用 `rg` 与 exports；inspect 用于声明与应用绑定，不代替任意 import 分析。

## 仓库约束

- `docs/` 维护公开用法，`engineering/` 维护架构与实现入口，`.agents/rules/` 提供设计方法。项目契约优先于通用默认；提案和历史记录不是当前 API 依据。文档冲突时核对 exports、实现、测试和调用方并修复。
- 当前服务本地工作区。修改契约时同步已知调用方，不为假设消费者保留兼容 alias、旧读取器或启动迁移；必要时一次性转换本地数据并删除转换代码。
- 保留原 API 名；只有命名冲突或来源歧义才加 alias，不为类型重复导入同一值，不添加无独立契约的 wrapper。
- 示例使用最短完整调用，包含必要的失败处理与资源释放。

## 服务与在线操作

mise 管工具、环境和 PATH，package scripts 管操作入口，Vite Task 管依赖与缓存，hk 管检查，Pitchfork 管托管进程；不再定义 mise tasks，可选 enter hook 仅触发已有只读诊断。

修改服务前检查配置与状态，优先用 Pitchfork 原生 start/stop/restart/status/list/logs/wait；添加后台进程、端口扫描、重试、轮询或生命周期脚本前，查[工作区指南](docs/development/workspace-toolchain.md)链接的官方能力和已安装 CLI 帮助。并行 worktree 隔离 namespace 与数据目录，只操作本任务所属服务。

已注册服务可由 URL 唤起，访问会执行启动命令。进程故障先查有界 Pitchfork 日志；应用配置、Workbench RPC、Plugin 方法/生命周期和业务日志必须使用现有 Vite 控制台：

1. `pluxel dev status` 确认 profile、Vite root、实例与应用状态；后续 `dev run` 保持选择，多个匹配实例才加 `--instance`。
2. 提交普通 TypeScript 导出函数，检查运行结果、领域/应用报告与日志。
3. 保存 `receipt`；`dev result/cancel` 使用原 receipt，不转投重启后的实例。

profile 选择、日志命令、服务就绪与应用 ready 的区别由 skill 和指南说明。隔离 test host 不能证明在线状态。

## 完成变更

- 按风险运行相关检查，报告实际结果与未验证边界；类型、运行时、公开导出和示例表达同一契约。
- 用户可见用法同步 `docs/`，内部边界同步所属工程文档；一处维护事实，其他入口链接。替换契约后搜索旧符号、入口和链接，包括生成项目的 AGENTS。
- 公开包用户可见变更添加 `.tegami/*.md`，含明确包 bump 类型和至少一个 Markdown 标题；纯内部重构、测试或文档变更无需空 changelog。
- 不手改 package 版本或 `.tegami/publish-lock.yaml`；交给 Tegami。
