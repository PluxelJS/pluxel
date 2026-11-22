---
title: 插件市场发布与管理
description: 使用 GitHub Actions 和 npm Trusted Publishing 发布插件，或在 PNPR 沙箱体验通知、收录与管理操作。
---

用本地 PNPR 和 workerd/D1 沙箱体验插件构建、发包通知、制品检查、分类和 Workbench 浏览。线上收录和运营使用 Cloudflare Worker + D1 主站。区域目录可独立部署，使用同一份公开目录快照同步。 [主站与只读镜像](https://github.com/PluxelJS/pluxel/blob/main/projects/plugin-market/README.md#只读镜像)

## GitHub Actions

独立插件的 GitHub 仓库根目录提交 `mise.toml`、`package.json` 与 `pnpm-lock.yaml`，并提供 Vite+ 模板中的 `vp run setup` 和 `vp run verify`。从旧版脚手架生成的项目可参考[当前模板](https://github.com/PluxelJS/pluxel/tree/main/packages/cli/templates/plugin)补齐这些入口。

下面将 `PLUXEL_WORKFLOW_SHA` 替换为包含对应 workflow 的 Pluxel 完整 commit SHA。GitHub 会检出调用方的源码，构建产物也保存在调用方的 Actions run。[GitHub 可复用工作流](https://docs.github.com/en/actions/concepts/workflows-and-actions/reusing-workflow-configurations)

### PR 构建与打包

在独立插件仓库保存为 `.github/workflows/ci.yml`。Actions 里可下载通过检查的 npm tarball。

```yaml
name: Plugin CI
on: pull_request

permissions:
  contents: read

jobs:
  build:
    uses: PluxelJS/pluxel/.github/workflows/plugin-build.yml@PLUXEL_WORKFLOW_SHA
```

### npm 发布和市场通知

公开插件仓库可将下例保存为 `.github/workflows/publish.yml`。包的 `repository.url` 指向该仓库。在 npm Trusted Publisher 设置中填入**插件仓库**的 owner、仓库名和 `publish.yml`。在 GitHub 仓库变量中设置 `PLUXEL_MARKET_URL`，并请市场运营方登记包与这两个 workflow 的身份。省略市场地址时只执行 npm 发布。[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) · [市场发布者登记](https://github.com/PluxelJS/pluxel/blob/main/projects/plugin-market/README.md#github-actions-发布通知)

```yaml
name: Publish Plugin
on:
  workflow_dispatch:

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    if: github.ref == 'refs/heads/main'
    uses: PluxelJS/pluxel/.github/workflows/plugin-publish.yml@PLUXEL_WORKFLOW_SHA
    with:
      market-url: ${{ vars.PLUXEL_MARKET_URL }}
```

发布 job 下载构建 job 生成的精确 tarball，用 npm 自己的 OIDC 凭据发布并生成 provenance。通知 job 另外向 GitHub 请求以市场通知端点为 audience 的 OIDC token。Job Summary 提供版本、回执链接和状态。发布成功但通知 job 失败时，可用 **Re-run failed jobs** 重试通知。

要让收录失败反映为 Actions 失败，可设置 `wait-for-indexing: true`，最长等待六分钟。当前自动 provenance 收录仍受 Worker 校验阻塞，开启等待可复现失败回执。发起 workflow 的成员可在 GitHub 开启网页或邮件通知。管理员可用 `notifications '{"status":"failed","limit":20}'` 查询失败回执和关联 Actions run。团队消息投递需要另行接入接收渠道。[GitHub Actions 通知设置](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications)

### 多包插件仓库

对整个插件仓库执行 PR 检查时，调用 `plugin-build.yml` 并传入 `pack-artifact: false`。发布时向 `plugin-publish.yml` 传入准确的 `package-name`，例如 `@pluxel/plugin-playwright`，它只上传和发布选中的包。各 npm 包分别登记调用方的仓库和发布 workflow。

如果插件仓库作为 Pluxel 的 `plugins/` submodule 开发，调用方可以额外传入已公开的完整 `framework-ref`。复用 workflow 检出指定框架，把调用方提交放到其中的 `plugins/`，使用框架的 catalog、冻结 lockfile 和 `workspace:ci` 验证。依赖变化需要配套更新框架的 lockfile 和该 pin。

### PNPR 私有 registry 演示

Pluxel 主仓库的 **Plugin market sandbox** workflow 可手动运行。它在 runner 上启动 PNPR 和 workerd/D1，执行本地构建、真实发包、回执去重、人工收录和目录验证。以下章节提供相同的本地入口。

## 启动本地市场与测试注册表

在仓库根目录下执行：

```sh
# 启动市场后端与私有 npm registry 服务
pitchfork start market

# 初始化本地演示插件与沙箱环境
vp run @pluxel-internal/plugin-market#sandbox:prepare

# 进入演示插件目录
cd projects/plugin-market/.local-market/plugin
. ./.market.env

# 构建并向本地私有市场发布插件
vp exec pluxel build
vp exec pluxel publish --webhook --market-url "$PLUXEL_MARKET_URL"
```

- 该流程将演示插件 `@market-demo/pluxel-plugin-hello` 发布到本地私有 PNPR 注册表中，并通过 Webhook 向本地市场端点提交发布通知。
- 控制台将输出发布回执 ID（Receipt ID），用于后续查询索引进度。

## 管理员手工审核与制品收录

在本地沙箱中，可通过管理员命令行工具查看收录通知、手动触发版本索引校验并设置分类标签：

```sh
# 加载环境变量
. projects/plugin-market/.local-market/plugin/.market.env

# 触发管理员审核并收录指定版本
vp run @pluxel-internal/plugin-market#sandbox:admin refresh --registry "$MARKET_REGISTRY" @market-demo/pluxel-plugin-hello 0.1.0

# 为插件配置分类与搜索标签
vp run @pluxel-internal/plugin-market#sandbox:admin metadata --registry "$MARKET_REGISTRY" @market-demo/pluxel-plugin-hello '{"expectedRevision":1,"official":false,"category":"development","tags":["market-demo","private-registry"]}'

# 查看插件收录元数据
vp run @pluxel-internal/plugin-market#sandbox:admin package --registry "$MARKET_REGISTRY" @market-demo/pluxel-plugin-hello
```

## 搜索与多维度筛选

市场服务内置了基于 SQLite FTS5 的全文检索能力，支持按包名、描述关键词以及打标分类进行多维度查询：

```sh
# 搜索特定关键字与官方标记
vp run @pluxel-internal/plugin-market#sandbox:admin catalog '{"query":"cache","official":true}'

# 按特定私有源筛选
vp run @pluxel-internal/plugin-market#sandbox:admin catalog --registry "$MARKET_REGISTRY" '{"query":"hello"}'

# 查询当前的分类与标签统计快照
vp run @pluxel-internal/plugin-market#sandbox:admin facets

# 读取公开 GitHub 仓库的归属与头像，再按作者和多个分类查目录
vp run @pluxel-internal/plugin-market#sandbox:admin repository @pluxel/fonts
vp run @pluxel-internal/plugin-market#sandbox:admin catalog '{"authors":["github:123"],"categories":["development","integration"]}'
```

对已有目录包执行 `repository` 后，用回执里的作者 ID 查询。同样的筛选可传给 `facets` 读取选项与计数。市场登记方式见 [管理 API](https://github.com/PluxelJS/pluxel/blob/main/projects/plugin-market/README.md#市场管理)。

## 在控制台（Workbench）中浏览插件市场

在宿主应用的 `PackageManagerPlugin` 配置中填入本地市场地址：

```json
{
	"markets": [{ "id": "market-local", "url": "http://127.0.0.1:8787" }]
}
```

启动宿主应用后，在 Workbench 侧边栏点击 **Marketplace**（或访问 `/market` 路由），即可在图形化界面中查看已收录的插件列表、版本发布历史与 README 文档。

## 运行端到端沙箱自动化验收

在仓库根目录下运行全套沙箱回归测试：

```sh
vp run @pluxel-internal/plugin-market#sandbox:verify
```

该命令会自动创建临时私有包，执行版本发布、Webhook 去重、制品元数据抽取、全量 FTS 索引与包可见性切换等一整套自动化流程。测试完成后，可通过以下命令停止本地服务：

```sh
pitchfork stop market market-registry
```
