# Pluxel 插件开发指南

这里首先服务插件作者和修改插件的 coding agent。绝大多数工作只需要阅读前四篇；宿主安装和
CLI 是独立的后续路径，不是理解插件设计的前置知识。

## 插件作者最短路径

1. [`plugin-authoring.md`](plugin-authoring.md)：从标准插件形状开始，掌握依赖、配置、生命周期、
   HTTP、Workbench Plane 和公开 capability。
2. [`testing.md`](testing.md)：使用 `@pluxel/test/vitest`、core/runtime test host 和 Vitest 验证真实
   插件生命周期、HTTP、失败传播、cleanup 与 disabled Workbench Plane。
3. [`plugin-best-practices.md`](plugin-best-practices.md)：写代码和 review 时使用的所有权决策、
   常见反模式与提交检查表。
4. [`oxlint.md`](oxlint.md)：Pluxel 增补规则保护的设计约束、修复方式和推荐配置。

如果从 CLI monorepo 模板开始，`pluxel new` 会把这组文档原样复制到生成仓库的
`docs/pluxel/`，根 `AGENTS.md` 会要求 coding agent 从 `docs/pluxel/README.md` 开始。生成项目
不维护另一套改写版 API 指南。

## 先做这四个判断

| 问题                                         | 选择                                                     |
| -------------------------------------------- | -------------------------------------------------------- |
| 缺少另一个插件时，本插件是否无法工作？       | 是：constructor required dependency；否：`plugins.use()` |
| 这段组成是否拥有独立插件生命周期和替换边界？ | 是：plugin；否：feature                                  |
| 这是业务 API 还是只服务管理 UI？             | 业务：`ctx.http.plugin`；管理：`ctx.workbench.mount()`   |
| 资源何时释放？                               | 创建成功后立即用 `ctx.effects.defer()` 登记幂等 cleanup  |

如果代码无法清楚回答其中一个问题，先解决所有权再继续扩展 API。Pluxel Oxlint 会自动检查
其中可静态判断的部分，但不能替代 required/optional 和业务/Workbench的设计判断。

## 其他任务

- [`workbench.md`](workbench.md)：管理工作台的导航、标签、插件分栏和高效空间使用。
- [`chatbots.md`](chatbots.md)：Chatbots 项目的跨平台/原生能力选择、顺序、背压和幂等边界。
- [`starter-monorepo.md`](starter-monorepo.md)：生成可独立运行、带本地插件指南和完整验证命令的
  canonical application monorepo。
- [`host-setup.md`](host-setup.md)：选择 static/dynamic Vite route，配置 Workbench Plane 和启动策略。
- [`tooling.md`](tooling.md)：CLI 可选能力、构建工具链和 HMR diagnostics 入口。

内部架构、实现入口和维护约束只存在于 Pluxel 源码仓库的 maintainer docs。插件作者不需要它们，
插件代码也不要导入 internal helper。

## 文档承诺

- 示例只使用当前公开 API。
- 先给标准写法和选择规则，再解释必要的设计原因。
- 不展示兼容 API、内部 helper 或迁移历史。
- 插件作者行为变化只更新这里；CLI 打包和 `pluxel new` 复制同一份文件，不维护平行指南。
