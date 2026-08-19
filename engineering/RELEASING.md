# Release Process

Pluxel 使用 Tegami 管理公开包版本、Version Packages PR、npm 发布锁、git tags 和 GitHub Releases。
发布自动化只在 `main` 的 CI push run 成功后运行；普通 pull request 和失败的 CI 不具备发布权限。

## 版本模型

- 公开包保持独立 semver，只有 `@pluxel/cli` 与同版本的 `@pluxel/create` 属于同步 release group；
- workspace-only、private、project 和 vendor package 在 `scripts/tegami.mts` 中显式忽略，不参与版本传播；
- semver-compatible 的第一方实现依赖使用 `workspace:^`，发布后成为 `^1.0.0`；只有限定同版本的
  `@pluxel/create -> @pluxel/cli` 使用 `workspace:*`；
- 第一方 peerDependencies 在源码中使用 `workspace:^`，发布后成为面向消费者的 `^1.0.0`；同时以
  `workspace:*` devDependency 提供仓库内构建和测试实现；
- Plugin package 对 runtime 和 required provider 一律使用 peer dependency，避免宿主图出现重复 Plugin identity；
- workspace 普通依赖变化只为公开 dependent 产生 patch bump，private dependent 不进入发布计划。

## 记录变化

用户可见的公开包变化通过 `pnpm tegami` 创建 `.tegami/*.md`，也可以按以下格式手工编写：

```md
---
packages:
  '@pluxel/runtime': minor
  '@pluxel/runtime-static': patch
---

## Describe the change

Explain the observable behavior and any migration requirement.
```

内部重构、测试和文档变更不需要空 changelog。不要手工修改 package versions、内部依赖版本或
`.tegami/publish-lock.yaml`。

`.tegami/` 只保存开源发布线中尚未 version 的变化。开源前的开发记录保留在 Git 历史和当前设计文档中，
不复制为 Tegami changelog，也不参与首次公开发行的版本计算。submodule 和 vendor workspace 拥有独立的
仓库与发布历史；根仓库 Tegami 不读取、转换或发布它们的 release metadata。

## 自动流程

1. Pull request CI 的 `release:check` 解析全部 pending changelog，并验证计划中只有允许发布的公开包。
2. 变更合并到 `main` 后，CI 完成通用 lint、format、typecheck、build 和 test。
3. `.github/workflows/release.yml` 由成功 CI 的 `workflow_run` 触发并执行 `pnpm tegami ci`。
4. 有 pending changelog 时，Tegami 更新 versions、package changelogs 和 lockfile，并创建或更新
   `tegami/version-packages` Version Packages PR；这一步不构建、不发布。
5. Version Packages PR 合并且 CI 成功后，Tegami 从已提交的 publish lock 发布 npm 包，创建 tags 和
   GitHub Releases。

publish lock 是发布事实来源。部分包发布失败时保留原 lock，重跑同一 workflow 会跳过已成功的包并继续未完成任务。
不要删除 pending lock 或通过手工 npm publish 绕过它。

## 发布验证

普通 CI 已完成 release metadata、workspace 治理、lint、format、typecheck、build 和单元测试。Release workflow
只接受同一 `main` commit 的成功 CI，并复用其 pnpm 和 Turbo cache，不重复这些通用检查。

真正发布时，Tegami hooks 只执行 package boundary 验证：

- `beforePublishAll` 从真实 CLI tarball 验证生成应用、独立插件模板和冻结发行物，整批发布只执行一次；
- `willPublish` 按 Tegami 当前即将发布的 package 调用 Turbo build，由 task graph 补齐其构建依赖；
- 已成功发布的 package 在失败重试时不会重新发布，未完成 package 仍会在发布前单独重建。

## Trusted Publishing

npm trusted publisher 绑定 `PluxelJS/pluxel` 和 `.github/workflows/release.yml`，发布使用 GitHub OIDC，
不保存长期 `NPM_TOKEN`。首次发布尚未在 npm registry 建立的包时，维护者在已有 publish lock 后执行：

```sh
pnpm tegami npm pretrust --dry-run
pnpm tegami npm pretrust
```

GitHub repository 必须允许 GitHub Actions 创建 pull request；workflow 的 `contents: write`、
`pull-requests: write` 和 `id-token: write` 权限不得降低。

## 本地检查

```sh
mise install
pnpm install --frozen-lockfile
pnpm verify
CI=true pnpm --filter @pluxel/cli test:templates
```

`release:check` 作为 `verify` 的前置步骤，验证精确工具版本、公开 package metadata、consumer peer ranges、
Tegami draft 和发布集合。模板命令复现整批发布前执行一次的 package boundary smoke，不修改版本或发布。
