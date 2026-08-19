# Release Process

Pluxel 使用 Changesets 管理公开包版本，并通过 GitHub Release 显式触发 npm trusted publishing。
合并到主分支不会自动发布。

## 版本模型

- `@pluxel/core`、runtime、toolchain 和辅助包保持各自的正常 semver；
- `valibot-form` 等独立包不跟随 Pluxel runtime 的版本线；
- 源码中的 workspace 内部 dependencies 使用 `workspace:*`，打包时由 pnpm 转成实际版本；面向使用者的
  peerDependencies 保留兼容 semver range；
- Changesets 只发布 npm 上尚不存在的包版本，不再递归重发整个 workspace。

用户可见变化在 PR 中运行 `pnpm changeset`，选择受影响的公开包和 bump 类型。纯内部重构、测试和
文档变更不需要空 Changeset。

## 准备版本提交

在最新且干净的 `main` 上执行：

```sh
mise install
pnpm install --frozen-lockfile
pnpm verify
pnpm release:version
pnpm install --lockfile-only
pnpm verify
```

检查 Changesets 生成的 package versions、changelogs 和 lockfile，然后把它们作为一个版本提交合并。
不要手工编辑单个内部依赖的发布版本；Changesets 根据 `updateInternalDependencies` 处理依赖 bump。

## 发布

从版本提交创建并发布 GitHub Release。`.github/workflows/release.yml` 会使用 `mise.toml` 安装完全相同的
工具版本，依次执行完整 verify、CLI 模板/打包 smoke，再运行 `changeset publish`。发布使用 npm
provenance 和 GitHub OIDC；npm 包的 trusted publisher 应绑定本仓库及 `release.yml`，不需要长期
`NPM_TOKEN`。

`pnpm release:check` 在 CI 和发布前验证：

- mise 保持 Node.js `lts` 与 pnpm `latest`，且不引入额外 JavaScript runtime；
- 所有公开包使用有效 semver、正确的 repository metadata 和 `AGPL-3.0-only` license metadata；
- 所有公开 npm 包都包含与根目录一致的 AGPL `LICENSE` 正文；
- 公开 workspace 包之间的普通源码依赖保持 `workspace:*`，peerDependencies 明确声明消费者兼容范围。

任何一步失败都必须修复后重新发布 GitHub Release，不能跳过 verify 或 smoke。
