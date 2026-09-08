# Release Process

Pluxel 使用 Tegami 管理公开包版本、Version Packages PR、npm 发布锁、git tags 和 GitHub Releases。
发布自动化只接受 `main` 的成功 CI push run；可以由 CI 完成自动触发，也可以手动触发。
普通 pull request 和失败的 CI 不具备发布权限。

## 版本模型

- 公开包保持独立 semver；`@pluxel/create` 与 `@pluxel/cli` 没有实现依赖或同步版本要求；
- 首次开源发布是唯一的版本收敛点：全部公开包由同一个 `major` Tegami intent 从 pre-1.0 原子进入
  `1.0.0`。源码阶段不手改版本；Version Packages PR 同步生成 package version、内部依赖和 publish lock。
- 全仓进入稳定线后新增的公开包仍从源码 `0.1.0` 开始，并以自己的 `major` intent 进入 `1.0.0`；它不会要求
  已稳定的其他公开包再次 major。治理只允许带有该 intent 的 pre-1.0 新包与既有 1.x 包暂时共存。
- workspace-only、private、project 和 vendor package 在 `scripts/tegami.mts` 中显式忽略，不参与版本传播；
- semver-compatible 的第一方实现依赖使用 `workspace:^`，发布后成为 `^1.0.0`；
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
不复制为 Tegami changelog，也不参与首次公开发行的版本计算。1.0.0 只保留一条首发说明和覆盖全部公开包的发布锁，不携带开发期日志；成功发布后由 Tegami 清理 pending lock。submodule 和 vendor workspace 拥有独立的
仓库与发布历史；根仓库 Tegami 不读取、转换或发布它们的 release metadata。

## 自动流程

1. Pull request CI 的 `governance:check` 解析全部 pending changelog，并验证计划中只有允许发布的公开包。
2. 变更合并到 `main` 后，CI 完成通用 lint、format、typecheck、build 和 test。
3. `.github/workflows/release.yml` 由成功 CI 的 `workflow_run` 触发并执行 `pnpm tegami ci`。
4. 有 pending changelog 时，Tegami 更新 versions、package changelogs 和 lockfile，并创建或更新
   `tegami/version-packages` Version Packages PR；这一步不构建、不发布。
5. Version Packages PR 合并且 CI 成功后，Tegami 从已提交的 publish lock 发布 npm 包，创建 tags 和
   GitHub Releases。

publish lock 是发布事实来源。部分包发布失败时保留原 lock，重跑同一 workflow 会跳过已成功的包并继续未完成任务。
不要删除 pending lock 或通过手工 npm publish 绕过它。

## 手动发布与重试

在 GitHub Actions → Release → Run workflow 选择 `main`，或运行：

```sh
gh workflow run release.yml --ref main
```

手动触发仍要求当前 `main` 的同一提交已有成功的 CI **push** run；没有通过时会明确报错，不会绕过检查。
它执行同一个 `pnpm tegami ci`：已有 publish lock 时发布，有 pending changelog 时更新版本 PR，没有待处理内容时不发布。
开发提交和 changelog 可以持续积累在版本 PR 中，由维护者合并版本 PR 决定发布时机。

自动触发的 Release 显示 skipped 时，先查看对应 CI：失败、取消或非 push run 都不会发布；仓库是否公开不影响这一检查。
修复 CI 后，新的成功 main push run 会自动触发 Release。若只是 npm 信任或发布阶段失败，可在初始化完成后手动重试当前 main。
旧提交的 Release 在 main 已前进时不会发布，请对当前 main 重新触发。

## 发布验证

普通 CI 已完成 release metadata、workspace 治理、lint、format、typecheck、build 和单元测试。Release workflow
只接受同一 `main` commit 的成功 CI，并复用其 pnpm 和 Turbo cache，不重复这些通用检查。

真正发布时，Tegami hooks 只执行 package boundary 验证：

- `beforePublishAll` 分别从真实 create/CLI tarball 验证 example workspace 与独立插件模板，整批发布只执行一次；
- `willPublish` 按 Tegami 当前即将发布的 package 调用 Turbo build，由 task graph 补齐其构建依赖；
- 已成功发布的 package 在失败重试时不会重新发布，未完成 package 仍会在发布前单独重建。

## Trusted Publishing

npm trusted publisher 绑定 `PluxelJS/pluxel` 和 `.github/workflows/release.yml`，发布使用 GitHub OIDC，
不保存长期 `NPM_TOKEN`。私有 GitHub repository 同样支持 OIDC，但 npm provenance 仅支持公开 repository；
Release workflow 按 repository visibility 开关 provenance。

首次设置需要 npm package write 权限、账号已启用 2FA，以及交互式 npm 登录。使用 mise 安装的工具链：
当前 Node 24.20.0 自带 npm 11.19.0，满足 `npm trust` 所需的 npm 11.15.0+。不要使用旧的全局 npm，
也不要使用 bypass-2FA granular token 配置信任。

首次 1.0.0 使用仓库的批量初始化脚本。它要求当前 Tegami publish lock 覆盖全部公开包；在已完成 version 的发布准备提交上运行，不要从尚未 version 的开发提交运行。

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- npm login
mise exec -- node scripts/prepare-npm-publishing.mts
mise exec -- node scripts/prepare-npm-publishing.mts --apply
```

默认只预览。`--apply` 先确认 npm 登录，再通过 Tegami `npm pretrust` 为缺失的包发布
`0.0.0-tegami-trusted-publish-setup` 空占位版本到 `temp` dist-tag；真正的 `1.0.0` 内容仍由 CI 发布。
随后脚本检查全部公开包，仅补齐缺少的 `PluxelJS/pluxel` / `release.yml` / 无 environment 限制 / 允许 publish
的 trusted publisher，并重新读取结果确认。已有正确配置会跳过，其他信任配置不会被自动删除。

账号必须有每个包的 write 权限以及创建 `@pluxel` scope 包的权限。初始化需要交互式 2FA；首次网页验证可选择
未来 5 分钟跳过重复 2FA，脚本在包之间等待 2 秒。无需逐包打开 npm settings，也不需要给 CI 保存 npm token。
脚本失败会明确退出；修复登录或权限后重跑，已经创建的占位包及已匹配的信任会被复用。

Tegami 可能更新本地 publish lock，运行后检查并提交这些生成的变更，不要手改 lock。最好在合并发布准备提交前
完成初始化；若 main 的 Release 已因缺少信任而失败，完成初始化后重跑最新 main 对应的 Release 即可，已成功发布的包会被跳过。
该脚本面向整批首发初始化；后续单个新包可以使用 Tegami `npm pretrust` 和 npm `trust` 命令。

GitHub repository 必须允许 GitHub Actions 创建 pull request；workflow 的 `contents: write`、
`pull-requests: write` 和 `id-token: write` 权限不得降低。

参考：[npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)、
[`npm trust` 的权限与批量设置要求](https://docs.npmjs.com/cli/v11/commands/npm-trust)。

## 本地检查

```sh
mise install
pnpm install --frozen-lockfile
pnpm verify
CI=true pnpm --filter @pluxel/create test:starter
CI=true pnpm --filter @pluxel/cli test:templates
```

`governance:check` 作为 `verify` 的前置步骤，同时验证精确工具版本、workspace 结构、公开 package metadata、
consumer peer ranges、Tegami draft 和发布集合。模板命令复现整批发布前执行一次的 package boundary smoke，
不修改版本或发布。公开包判定和 Tegami ignore 都来自共享 repository package inventory：只有
`packages/*`、`plugins/*` 中未标记 `private` 的包可发布，root、project 和 private package 自动排除。
首次发布完成前，治理还会拒绝部分 package 提前进入 1.x 或任一公开 package 缺少 `major` intent。
