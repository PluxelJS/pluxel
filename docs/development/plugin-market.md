---
title: 插件市场发布与管理
description: 使用 GitHub Actions 发布到 npm 或自建 registry，体验插件安装、市场通知与收录。
---

用本地 PNPR 和 workerd/D1 沙箱体验插件构建、发包通知、制品检查、分类和 Workbench 浏览。参考市场运行在 Cloudflare Worker 中，可以读取标准 npm registry，也可以启用自建 registry 接收发布。区域目录可独立部署，使用同一份公开目录快照同步。[参考市场与只读镜像](https://github.com/PluxelJS/pluxel/blob/main/projects/plugin-market/README.md)

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

要让收录失败反映为 Actions 失败，可设置 `wait-for-indexing: true`，最长等待六分钟。公开 npm 的 provenance 收录仍受 Worker 校验阻塞，开启等待可复现失败回执。发起 workflow 的成员可在 GitHub 开启网页或邮件通知。管理员可用 `notifications '{"status":"failed","limit":20}'` 查询失败回执和关联 Actions run。团队消息投递需要另行接入接收渠道。[GitHub Actions 通知设置](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications)

### 自建 registry 发布

部署方先启用 [自建 registry](https://github.com/PluxelJS/pluxel/blob/main/projects/plugin-market/README.md#自建插件-registry)，为 scoped 包登记调用方及固定的复用 workflow SHA。沿用上例的 `permissions`，为 `publish` job 增加 `registry-url`。要启用私源收录，同时在市场的对应 `REGISTRIES` 条目中登记 `githubPublishers`。

```yaml
jobs:
  publish:
    if: github.ref == 'refs/heads/main'
    uses: PluxelJS/pluxel/.github/workflows/plugin-publish.yml@PLUXEL_WORKFLOW_SHA
    with:
      registry-url: ${{ vars.PLUXEL_REGISTRY_URL }}
      market-url: ${{ vars.PLUXEL_MARKET_URL }}
      wait-for-indexing: true
```

`PLUXEL_REGISTRY_URL` 形如 `https://market.example.com/npm`，`PLUXEL_MARKET_URL` 使用市场 origin。发布和通知各自使用对应 audience 的短期 OIDC token。只发包时省略 `market-url`。使用传统私源的专用通知凭据时，通过可选的 `market-notification-token` secret 传入。下载私有包时，npm 和 Pluxel 安装器使用部署方发放的 registry 读凭据。[GitHub 可复用工作流的 OIDC claim](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows) · [安装器与私有 registry](../plugins/package-manager.md)

### 多包插件仓库

对整个插件仓库执行 PR 检查时，调用 `plugin-build.yml` 并传入 `pack-artifact: false`。发布时向 `plugin-publish.yml` 传入准确的 `package-name`，例如 `@pluxel/plugin-playwright`，它只上传和发布选中的包。各 npm 包分别登记调用方的仓库和发布 workflow。

如果插件仓库作为 Pluxel 的 `plugins/` submodule 开发，调用方可以额外传入已公开的完整 `framework-ref`。复用 workflow 检出指定框架，把调用方提交放到其中的 `plugins/`，使用框架的 catalog、冻结 lockfile 和 `plugins:ci` 验证。该任务构建插件需要的框架产物，执行插件检查、类型检查、测试及 Typst WASM 验收。依赖变化需要配套更新框架的 lockfile 和该 pin。

### PNPR 私有 registry 演示

Pluxel 主仓库的 **Plugin market sandbox** workflow 可手动运行。它在 runner 上启动 PNPR 和 workerd/D1，执行本地构建、真实发包、回执去重、私有源自动收录和目录验证。以下章节提供相同的本地入口。

## 接入其他市场

Pluxel 维护插件制品规范、发布入口、可互操作的 HTTP 目录与安装器。任何市场都可以实现这个目录，管理自己的来源、可见性、精选列表、分类和标签。Worker/D1 是可自行部署的参考实现。宿主配置的 `markets[].url` 可以指向不同实现或只读镜像。[插件制品](./plugin-package.md) · [宿主配置市场](../plugins/package-manager.md#连接插件市场)

市场实现按下面的路径提供 JSON。`name` 和 `version` 各自编码为一个 URL 段。`registry` 使用规范化的来源 URL，例如 `https://registry.npmjs.org`。同名包可以同时存在于不同来源。

| 接口                                                  | 契约                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| `GET /v1`                                             | 声明协议版本、来源和能力                                        |
| `GET /v1/packages`、`GET /v1/facets`                  | 返回筛选后的目录分页与相同条件下的分面计数                      |
| `GET /v1/packages/:name?registry=…`                   | 包摘要、上游 `distTags`、README、许可证与已收录范围             |
| `GET /v1/packages/:name/releases?registry=…`          | 已检查发行分页，`coverage` 为 `indexed-only`                    |
| `GET /v1/packages/:name/releases/:version?registry=…` | 精确发行、SHA-512 `integrity`、检查时间、依赖和 provenance      |
| `POST /v1/notifications`、`GET /v1/notifications/:id` | 可选发布通知，持久接收 `{ registry, name, version }` 并提供回执 |

目录筛选参数 `registry`、`category`、`tag` 和 `author` 可以重复传入。组内任意值命中，组间同时满足。包和发行的分页默认 20 条，最多 50 条，下一页使用服务端生成的 `nextCursor`。不可见的包和未收录的精确发行返回 `404`。完整响应字段、分面计数和快照规则见 [参考实现 HTTP 契约](https://github.com/PluxelJS/pluxel/blob/main/projects/plugin-market/README.md#http-契约)。

`category` 是市场选定的单个分类，可为 `null`。`tags` 是市场选定的最多 20 个标签。分类和标签使用 `/^[a-z0-9][a-z0-9-]{0,31}$/`，各市场可自行定义词表。`official` 是该市场的精选判断，`provenance` 则记录具体发行的证明状态。npm `keywords` 可作为提取和搜索的输入，收录决策由市场运营方掌握。

安装时，宿主依据部署配置从选中的 registry 解析并下载精确版本，核对市场的 SHA-512，再确认发布同一份制品。目录中的展示字段、来源链接和市场自己的 CDN 不参与安装决策。若同一个精确发行需要更换字节，发布新版本。上游 `latest` 指向尚未收录的发行时，目录仍可浏览，安装器只能选择已收录的精确发行。

### 丰富目录信息

许可证、发行时间、直接依赖和包展开大小适合从 npm 获取，并标明对应版本。传递依赖、安装大小和漏洞数适合带各自的解析口径、观测时间和数据来源，供市场可选展示。没有安全数据时显示未知。截图和图标适合由发布者显式挑选，首选发行制品中的已检查文件。现有 README 渲染器把图片保留为文字，图片展示可通过市场受控托管再启用。[npm manifest](https://docs.npmjs.com/cli/configuring-npm/package-json/) · [npmx 的依赖、大小与安全数据](https://docs.npmx.dev/guide/features)

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
- 控制台将输出发布回执 ID。沙箱的 PNPR 来源已启用无证明发行的自动收录，可用 `sandbox:admin process` 执行与生产定时处理相同的一批任务，再查询回执。带证明的发行仍需通过证明校验。

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

该命令会自动创建临时私有包，执行版本发布、Webhook 去重、自动收录、制品元数据抽取、FTS 索引与包可见性切换。安装器另外使用独立 HTTP 目录与真实 pnpm 验证准备、确认和生产 Vite Host 加载。测试完成后，可通过以下命令停止本地服务：

```sh
pitchfork stop market market-registry
```
