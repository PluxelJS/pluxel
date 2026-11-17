# 发布流程

Tegami 管理公开包版本、Version Packages PR、npm publish lock、git tags 与 GitHub Releases。发布自动化接受 `main` 同一提交的成功 CI push run，由 CI 完成事件或手动触发。

## 版本模型

公开包使用 Core 的统一版本线。`pluxel` group 的 `syncBump` 同步 bump 类型，`syncGitTag` 合并 tag；绝对版本由 `scripts/release-policy.mts` 的 Tegami `initDraft` hook 计算。

- 无显式目标时，从原始 pending bump 选择组内最高类型，以 draft 创建时的 Core 版本计算一次目标。稳定包的 major 推进整组 major；pre-1.0 新包须有自身初发 major intent，该意图使既有组推进 minor，新包加入当次版本线。
- `release-X.Y.Z.md` 是显式稳定目标的保留文件名，只允许一个严格高于 Core 当前版本的目标。记录须是普通有效 changelog，声明 bump 且不能 replay。维护者显式选择目标时仍保留原始 bump 和 breaking/migration 说明。
- 无 pending bump 时不创建新计划。已消费目标不会从旧 publish lock 再次读取。Tegami 应用 draft 时生成版本、内部依赖、changelog 与 publish lock。
- 公开集合来自 `scripts/repository-packages.mjs`：packages/plugins 中非 private 包参与，root、project、vendor 与独立 submodule 发布线排除。官方 Plugin 使用 `@pluxel/plugin-xxx`；既有稳定版本与 Core 对齐。
- 第一方实现与可发布 peer 使用 `workspace:^`，本地 peer 实现配 `workspace:*` devDependency；Plugin provider 使用 peer 维持身份。workspace-only provider 和外部 catalog 规则见 [Governance](GOVERNANCE.md#依赖与版本)。workspace 普通依赖变更只给公开 dependent 传播 patch。

## 发布说明格式

`.tegami/*.md` 声明公开包 bump 与 Markdown 说明，一份文件可覆盖多个包：

```md
---
packages:
  '@pluxel/host': minor
  '@pluxel/services': patch
---

## Describe the change

Explain the observable behavior and any migration requirement.
```

package versions、内部依赖版本和 `.tegami/publish-lock.yaml` 由 Tegami 生成。站点和包内已生成 changelog 属于版本记录；pending Markdown 用于下一次 version。

## 自动流程

1. PR CI 的 `governance:check` 校验已有 pending metadata、公开目标和版本一致性；有发布计划时检查新包初发 intent。
2. 合并到 main 后，CI 执行 `workspace:ci`，范围见[工作区工具链](../docs/development/workspace-toolchain.md#github-actions)。
3. `.github/workflows/release.yml` 接收成功 CI 的 `workflow_run`，执行 `vp run tegami ci`。
4. 有 pending changelog 时，Tegami 更新 versions、包 changelog 与 lockfile，创建或更新 `tegami/version-packages` PR，此阶段不构建或发布。
5. 版本 PR 合并且同一提交 CI 成功后，从提交的 publish lock 发布 npm、创建 tags 与 GitHub Releases。

版本 PR 使用 GITHUB_TOKEN 创建时，GitHub 会将其 PR workflows 置为等待批准。维护者审查版本变更，再在 PR 选择 **Approve workflows to run** 并按正常流程合并。见 [GitHub 触发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow)。

publish lock 是执行发布的依据。部分包失败时保留原锁，重跑会跳过成功包并继续剩余任务。重做尚未发布的旧计划时，先显式恢复旧锁中未发布说明为 pending Markdown，保留正文并审查已移除/更名目标，然后由 Tegami 重新生成；draft 不会自动合并旧锁内容。已发布内容保留其原发布记录。

## 手动发布与重试

在 GitHub Actions → Release → Run workflow 选择 main，或运行：

```sh
gh workflow run release.yml --ref main
```

手动触发同样要求当前 main 提交有成功的 CI push run。`vp run tegami ci` 有 publish lock 时发布，有 pending changelog 时更新版本 PR，无待处理内容时结束。

Release skipped 先看对应 CI：失败、取消或非 push run 均不会发布。修复后新的成功 main push 会自动触发；npm 信任或发布阶段失败可手动重试当前 main。main 已前进时，旧提交的 Release 不再发布。

## 发布验证

CI 完成治理、release metadata、格式与所选包的 lint/typecheck/build/test。Release 复用同提交成功 CI，只做 package boundary 验证：

| Hook               | 工作                                                          |
| ------------------ | ------------------------------------------------------------- |
| `beforePublishAll` | 从真实 create/CLI tarball 验证生成应用与独立 Plugin；整批一次 |
| `willPublish`      | 对当前 package 调用 Vite Task compile，由任务图补齐依赖       |
| 失败重试           | 跳过已发布包，对剩余包发布前重新构建                          |

发布 job 从锁定依赖安装，不恢复其他运行写入的 mise、pnpm、Vite Task 或 native build cache。同一次发布内可复用本轮 task 产物，CI 自身继续使用缓存；依据见 [mise-action 发布指南](https://github.com/jdx/mise-action/tree/v5.2.0#release-workflows)。

Release 不准备 Rust/Typst 原生库。Takumi Markdown 公开构建依赖 Typst 的 `compile-lib`（JS、声明、Plugin reference）；native 集成测试与 Typst 完整 build/compile 仍准备原生库。

## 模板发行版本

create/CLI 在 Vite+ Pack `build:done` 复制模板后，共用构建专用 pncat sync 更新 `dist/template` / `dist/templates/plugin` catalog。第一方范围取公开 inventory 当前 manifest 的 `^version`，外部依赖遵循 workspace 政策；源码模板保持可读基线。

任务缓存输入含同步函数、inventory 与公开 manifests，CLI 源码指纹也含模板与 manifests。版本 PR 后自然生成新范围。生成测试检查范围，真实 tarball smoke 检查安装、构建与启动。

## Trusted Publishing

npm trusted publisher 绑定 `PluxelJS/pluxel` 与 `.github/workflows/release.yml`，使用 GitHub OIDC。workflow 按仓库 visibility 开关 provenance：公开仓库支持 provenance，私有仓库可用 OIDC。设置需要 package write、账号 2FA 和交互式 npm 登录。

使用 `vp exec npm --version` 核对 npm 11.15.0+ 的 `npm trust` 支持。在已完成 version 的发布准备提交上初始化；批量脚本要求 publish lock 覆盖全部公开包：

```sh
vp install --frozen-lockfile
vp exec npm login
vp exec node scripts/prepare-npm-publishing.mts
vp exec node scripts/prepare-npm-publishing.mts --apply
```

默认预览。apply 确认登录后，用 Tegami npm pretrust 为缺失包发布 `0.0.0-tegami-trusted-publish-setup` 空占位到 temp tag，正式内容由 CI 发布。随后只补齐缺少的 repository/workflow/无 environment 限制/允许 publish 的信任，并重新读取确认。已有正确配置复用，其他信任不自动删除。

账号需要所有目标包的 write 与创建 scope 包权限。初始化交互式 2FA 可选择未来五分钟跳过重复验证，脚本包间等待两秒；失败后修复登录/权限可重跑。使用正常 npm 登录，避免 bypass-2FA granular token。CI 无需长期 NPM_TOKEN。

Tegami 可能生成 publish lock 更新，检查后提交。只发布部分包时，单个新包使用 Tegami npm pretrust 与 npm trust。若 main 发布因缺少信任失败，初始化后重跑最新 main 的 Release。

### GitHub 版本 PR 权限

创建版本 PR 同时需要 workflow 的 `contents: write` / `pull-requests: write`，以及 Settings → Actions → General 中 **Allow GitHub Actions to create and approve pull requests**。仓库默认可保持 read；组织策略须先允许。开关不可选或 API 返回 409 时由组织所有者调整，job permissions 无法覆盖组织策略。

管理员可检查：

```sh
gh api repos/PluxelJS/pluxel/actions/permissions/workflow
```

`GitHub Actions is not permitted to create or approve pull requests` 属于版本 PR 创建阶段；修复 GitHub 策略后重跑当前 main。npm 信任错误在实际 publish 阶段处理，OIDC 还需 `id-token: write`。参考 [GitHub Actions 设置](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#preventing-github-actions-from-creating-or-approving-pull-requests)、[npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)、[npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust)。

## 本地检查

```sh
mise install
vp install --frozen-lockfile
vp run verify
CI=true vp run @pluxel/create#test:starter
CI=true vp run @pluxel/cli#test:templates
```

verify 的治理前置检查工具 pin、workspace、metadata、peer、Tegami 公开集合与有计划时的初发 intent。两个模板命令复现整批发布前的真实消费检查，检查本身不修改版本或发布。
