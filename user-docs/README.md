# Pluxel 插件开发指南

这里首先服务插件作者和修改插件的 coding agent。绝大多数工作只需要阅读前三篇；宿主安装和
CLI 是独立的后续路径，不是理解插件设计的前置知识。

## 插件作者最短路径

1. [`plugin-authoring.md`](plugin-authoring.md)：从标准插件形状开始，掌握依赖、配置、生命周期、
   HTTP、Web Management 和公开 capability。
2. [`plugin-best-practices.md`](plugin-best-practices.md)：写代码和 review 时使用的所有权决策、
   常见反模式与提交检查表。
3. [`oxlint.md`](oxlint.md)：Pluxel 增补规则保护的设计约束、修复方式和推荐配置。

如果从 CLI monorepo 模板开始，生成仓库中的 `AGENTS.md` 和
`docs/PLUXEL_PLUGIN_GUIDE.md` 会把这条主路径压缩成项目内可直接执行的说明；coding agent
不需要先探索 Pluxel 源码仓库。

## 先做这四个判断

| 问题                                         | 选择                                                     |
| -------------------------------------------- | -------------------------------------------------------- |
| 缺少另一个插件时，本插件是否无法工作？       | 是：constructor required dependency；否：`plugins.use()` |
| 这段组成是否拥有独立插件生命周期和替换边界？ | 是：plugin；否：feature                                  |
| 这是业务 API 还是只服务管理 UI？             | 业务：`ctx.http.plugin`；管理：`webManagement.use()`     |
| 资源何时释放？                               | 创建成功后立即用 `ctx.effects.defer()` 登记幂等 cleanup  |

如果代码无法清楚回答其中一个问题，先解决所有权再继续扩展 API。Pluxel Oxlint 会自动检查
其中可静态判断的部分，但不能替代 required/optional 和业务/管理面的设计判断。

## 其他任务

- [`starter-monorepo.md`](starter-monorepo.md)：生成可独立运行、带本地插件指南和完整验证命令的
  canonical application monorepo。
- [`host-setup.md`](host-setup.md)：选择 static/dynamic Vite route，配置 Web Management 和启动策略。
- [`tooling.md`](tooling.md)：CLI 可选能力、构建工具链和 HMR diagnostics 入口。

内部架构、实现入口和维护约束位于 [`docs/`](../docs/README.md)。只有修改 Pluxel 本身时才需要
阅读；插件代码不要导入其中提到的 internal helper。

## 文档承诺

- 示例只使用当前公开 API。
- 先给标准写法和选择规则，再解释必要的设计原因。
- 不展示兼容 API、内部 helper 或迁移历史。
- 插件作者行为变化会同步更新主路径、Oxlint 规则说明和 CLI 模板内指南。
