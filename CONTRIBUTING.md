# 参与贡献

感谢你帮助改进 Pluxel。Issue、文档、测试、错误修复和功能实现都很有价值。

## 开始之前

- 使用 GitHub Issues 讨论缺陷和范围明确的改进；较大的 API 或架构变化请先说明问题、使用场景和兼容性影响。
- 安全漏洞不要提交公开 Issue，请按照 [安全策略](./SECURITY.md) 私下报告。
- 提交贡献即表示你同意本项目的 [Contributor License Agreement](./CLA.md)。你仍然保留贡献内容的版权。

## 准备开发环境

仓库通过 mise 管理 Node.js 与 pnpm 版本：

```sh
git clone https://github.com/PluxelJS/pluxel.git
cd pluxel
mise trust
mise install
pnpm install --frozen-lockfile
pnpm verify
```

如果不使用 mise，本地工具仍须满足根 `package.json` 中的版本约束。不要提交 `node_modules/`、`dist/`、`.turbo/`、`.pluxel/`、`.bench-results/` 或 `local-projects/` 中的本地产物。

## 修改规则

1. 修改前先阅读 [工程文档入口](./engineering/README.md) 和相关领域文档。
2. 用户可见行为必须同步更新 `docs/`；内部架构约束更新 `engineering/`，不要把未实现设计写成当前能力。
3. 新增或修改公开 API、类型、错误契约、配置契约或资源生命周期时，遵循 [library API design guide](./.agents/rules/library-api-design.md)。
4. 保持 package boundary；只从 `package.json#exports` 声明的入口导入，不使用其他 package 的源码相对路径。
5. 为行为变化补充测试，并确保 acquire 的长期资源在 replacement、rollback 与 shutdown 时都能释放。

## 验证

提交前运行完整门禁：

```sh
pnpm verify
```

开发期间可以先运行更小的反馈循环：

```sh
pnpm --filter <package-name> test
pnpm --filter <package-name> typecheck
pnpm lint
pnpm format:check
```

不要通过削弱测试、跳过检查或提交生成缓存来让验证通过。

## Changeset

公开 package 的用户可见变化需要 Changeset：

```sh
pnpm changeset
```

只选择公开行为实际发生变化的 package，并写清楚用户会感知到的结果。纯文档、测试或不影响公开行为的内部重构不需要空 Changeset。版本与发布规则见 [发布指南](./engineering/RELEASING.md)。

## Pull Request

- 保持一个 PR 聚焦于一个问题，并说明动机、主要变化和验证方式。
- UI 或交互变化请附截图；兼容性变化请明确迁移方式。
- 勾选 PR 模板中的检查项。
- 阅读 [CLA](./CLA.md) 后，在 PR 中评论 `/approve-cla`。自动化会记录并验证同意状态。

维护者可能要求补充测试、文档或 Changeset。所有检查通过并不保证合并，但会让评审集中在设计和行为本身。
