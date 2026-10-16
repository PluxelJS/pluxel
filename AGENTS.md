# Coding agent 工作入口

先确认任务属于应用/插件开发还是框架维护，再读取对应文档。已知目标时直接定位文件；不要为一个局部改动通读全部文档。

**首要设计目标：契约可读、行为可观测、修复可审查。** 让人和 coding agent 能从代码与反馈定位权威输入并验证修改；显式维护工具可以自动修复，运行时不得暗中改写错误契约以伪装成功。具体边界见[工程原则首节](engineering/DESIGN_PRINCIPLES.md#首要目标契约可读行为可观测修复可审查)。

应用/插件开发与在线排障使用 [pluxel-development skill](.agents/skills/pluxel-development/SKILL.md)，优先选择 inspect、项目静态检查、隔离插件测试与现有 dev console。根据修改风险实际执行验证；`pluxel docs` 输出当前开发来源的文档正文。完成时报告检查结果与未验证的边界。

## 按任务读取

| 任务                                                       | 必读入口                                                                               | 下一步                                                                    |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 工作区工具、提交检查与开发服务                             | [工作区工具链](docs/development/workspace-toolchain.md)                                | 先读 mise.toml、vite.config.ts、hk.pkl、pitchfork.toml 与已有服务         |
| 修改插件业务、配置声明或日志                               | [插件开发范式](docs/plugin-development/index.md)                                       | 已知主题直接读目标页；验证方式见[开发指南](docs/development/index.md)     |
| 装配应用、部署绑定或输出                                   | [Host 配置](docs/host/configuration.md)                                                | 直接读对应配置章节；服务扩展再读 host/services                            |
| 修改 Workbench 导航、布局、目录或视觉                      | [Workbench 交互设计](engineering/WORKBENCH_DESIGN.md)                                  | 再按 [Frontend](engineering/FRONTEND.md) 定位状态所有者和验收入口         |
| 编写或重组文档                                             | [文档职责](engineering/DOCUMENTATION.md)                                               | 分离插件、Host、验证与实现约束；检查链接和实际读取入口                    |
| 修改框架、Context 服务、生命周期、工具链或包边界           | [工程原则](engineering/DESIGN_PRINCIPLES.md)、[系统边界](engineering/PLUGIN_SYSTEM.md) | 从 [工程索引](engineering/README.md) 选择涉及的领域，再读实现和测试       |
| 创建或修改公共 API、配置、类型、错误、扩展点或资源生命周期 | [API 设计规则](.agents/rules/library-api-design.md)                                    | 先读执行方式与硬约束，再按变更类型读取相关规则；检查 exports 和真实调用方 |
| 设计本地 Plugin 可恢复失败                                 | [Better Result](./docs/plugin-development/better-result.md)                            | 明确调用方如何恢复；保留原生 SDK、判定、回执和生命周期失败契约            |
| 操作已运行的应用                                           | [开发控制台](docs/development/dev-console.md)                                          | 确认 profile、Vite root、实例与应用状态                                   |
| 添加隔离回归                                               | [插件测试](docs/plugin-development/testing.md)                                         | 框架测试设施的边界见 [工程测试](engineering/TESTING.md)                   |

普通源码查找使用 `rg`、package exports 和领域文档的实现入口。inspect 用于确认声明与应用绑定关系；目标和相关声明已明确时直接读源码，不为执行流程重复查询。它不代替任意 import 影响分析或框架内部搜索。

先满足本任务的必读约束；链接是按需展开的入口，不要求递归读完。同一任务中未变化的文档无需重读。能明确改动位置、契约与所有者、受影响调用方、验证方式后，就开始实现；遇到事实冲突、未知行为或跨领域影响时，再补读对应章节，不靠猜测填空。

## 当前事实与设计决策

- `docs/` 拥有公开用法；`engineering/` 拥有架构约束和实现入口；`.agents/rules/` 提供可复用的设计方法。项目约束、已有契约和领域惯例优先于通用默认。
- 提案、实验和历史记录不作为当前 API 依据。文档与源码冲突时检查 exports、实现、测试和调用方，修复差异，不默默选择其中一份。
- Pluxel 当前服务此工作区的本地仓库。修改契约时同步更新已知调用方，不为假设的外部消费者保留兼容 alias、旧格式读取器或启动迁移路径。必要时一次性转换已有本地数据，然后移除转换代码。
- 保留原 API 名称。只有解决命名冲突或来源歧义时才加 alias；不为取得类型重复导入同一个值，不添加无独立契约的 wrapper。
- 示例展示最短完整调用，包含必要的失败处理和清理。不要让调用方猜入口、状态或副作用。

## 开发服务

mise.toml 配置工具版本、环境和 PATH，可选 enter hook 只触发已有只读诊断；项目操作由 package scripts 提供，依赖图与缓存由 Vite Task 声明，不再定义 mise tasks。默认通过 mise 提供工具、Vite+ 执行任务图与打包/lint/格式化、hk 管理检查、Pitchfork 管理开发服务。修改前先检查 `pitchfork.toml` 与运行服务；优先使用 Pitchfork 的 start、stop、restart、status、list、logs、wait。新增后台进程、端口扫描、重试、轮询或生命周期脚本前，先查[工作区指南](docs/development/workspace-toolchain.md)链接的官方能力和已安装 CLI 帮助。并行 worktree 使用独立 namespace 与数据目录；只操作本任务所属服务。Pitchfork 管进程，Pluxel 应用操作仍遵守下节 dev console 约束。

具体流程见[按访问启动](docs/development/workspace-toolchain.md#按访问启动与服务复用)和[日志与排障顺序](docs/development/workspace-toolchain.md#agent-的日志与排障顺序)：

- 先发现并复用目标服务；已注册项目可通过公开 URL 唤起，首次 checkout 仍需准备依赖并注册或启动。URL 访问会执行服务及依赖的启动命令，不是纯只读探测。
- 启动、编译或进程退出问题先用 `pitchfork logs <完整服务ID> --since 5min -n 100 --no-pager`；按需短暂 follow，不读取全部历史或另起 Vite 捕获日志。
- 应用 ready、HMR 接纳与业务效果使用 dev console 验证；代理启动页、HTTP 响应和进程 running 均不能替代应用报告。重启后重新查询目标状态；旧操作仍用原 receipt 恢复。

## 在线操作

对已运行应用的配置修改、Workbench RPC、Plugin 方法、生命周期操作和应用业务日志读取，必须使用现有 Vite 进程的开发控制台：

1. 通过 `pluxel dev status` 确认 profile、Vite root 与实例，`dev run` 使用同一 profile；profile 按显式 `--profile`、配置 default、唯一候选选择；跨目录用 `--root` 选择配置发现起点。匹配 profile 的实例仍有多个时指定 `--instance`，不能绕过归属检查。控制台不依赖 Pitchfork，也不自动启动服务。`console: false` 的文档站只提供 Pitchfork 启动和状态，不能用于在线应用操作。
2. 提交普通 TypeScript 导出函数。
3. 检查运行结果、领域/应用报告和相关日志。保存 `receipt`；`dev result/cancel` 只接受原 receipt，不切换到重启后的实例。

隔离 test host 不能证明在线状态。具体调用与限制只维护在[控制台指南](docs/development/dev-console.md)。

## 完成变更

- 根据风险运行相关检查；类型、运行时行为、公开导出和示例必须表达同一契约。
- 用户可见行为同步更新 `docs/`；内部边界变化同步更新所属工程文档。一个事实维护一处，其他入口链接它。
- 删除或替换契约后搜索旧符号、旧入口和文档链接；生成项目的 AGENTS 也要检查。
- 公开包的用户可见变更必须添加 `.tegami/*.md`，包含明确的包 bump 类型和至少一个 Markdown 标题。纯内部重构、测试或文档修改不需要空 changelog。
- 不手改 package 版本或 `.tegami/publish-lock.yaml`；版本和内部依赖更新由 Tegami 管理。
