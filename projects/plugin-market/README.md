# 插件市场

Cloudflare Worker + D1 是唯一可写主站，负责目录、上游观测、制品检查、运营编辑与通知。公开市场网页和 Package Manager 可以读取主站或独立部署的只读镜像。安装及运行由 Package Manager 与 Host 负责。

同一市场可配置公共 npm 与私有 PNPR。包身份是 `registry + name`，发行身份再加精确 `version`。PNPR 代理公共 npm 时也保留实际读取的来源。搜索直接查询所在服务的 SQLite 数据。

## 本地运行与来源配置

从构建发布、通知到市场管理的操作见 [PNPR 本地体验指南](../../docs/development/plugin-market.md)。Miniflare 和 Pitchfork 用于本地 workerd/D1 联调，主站通过 Wrangler 部署。

直接使用 Wrangler 时，在本目录执行 `vp run db:migrate:local`，在忽略的 `.dev.vars` 中设置 `ADMIN_TOKEN`，然后执行 `vp run dev`。默认来源为公共 npm。多来源由部署方通过 `REGISTRIES` JSON 设置：

```json
[
	{ "registry": "https://registry.npmjs.org", "access": "public" },
	{
		"registry": "https://packages.example.com/npm",
		"access": "admin",
		"token": "UPSTREAM_READ_CREDENTIAL",
		"notificationToken": "SEPARATE_NOTIFICATION_CREDENTIAL"
	}
]
```

这是部署配置，不接受通知发送者添加网络目标。registry 使用 HTTPS，本机 loopback 另允许 HTTP；支持路径前缀，坐标不带末尾 `/`、凭据、query 或 fragment。上游 token 只发送到对应 origin 与路径前缀，不跟随重定向。配置凭据不进入公开 DTO。

匿名目录只包含 `access: public` 来源，私有包详情与回执返回 `404`。管理员 Bearer token 可读全部来源；独立通知 token 只可提交该私源通知、读取其回执，不能浏览私有目录或操作后台。当前没有普通用户的私有目录权限系统。

Wrangler 的 D1 ID 默认只供本地运行；远程部署方需创建 D1、设置实际 ID、保存 secrets 并显式应用迁移。`compile` 构建静态网页后执行部署 dry-run。运行时不清空或自动修复数据库。

## GitHub Actions 发布通知

在公开来源的 `githubPublishers` 登记精确包名和获准的 workflow。可为同一包登记多个调用方或并行过渡的固定 SHA。插件仓库的数字 ID 和 owner ID 可从 `gh api repos/OWNER/REPO --jq '[.id, .owner.id]'` 查询。

```json
[
	{
		"registry": "https://registry.npmjs.org",
		"access": "public",
		"githubPublishers": [
			{
				"name": "@acme/pluxel-plugin-orders",
				"repositoryId": "123456",
				"repositoryOwnerId": "789012",
				"workflowRef": "acme/orders/.github/workflows/publish.yml@refs/heads/main",
				"jobWorkflowRef": "PluxelJS/pluxel/.github/workflows/plugin-publish.yml@0123456789abcdef0123456789abcdef01234567"
			}
		]
	}
]
```

通知发送到 `POST /v1/notifications`，正文仍是 `{ registry, name, version }`。Worker 用 GitHub 的公开 JWKS 验证 JWT、有效期和 audience。Audience 使用该通知端点的完整 URL，例如 `https://market.example.com/v1/notifications`。授权核对调用方的两个数字 ID、`workflow_ref` 和实际 Git ref，并在配置了 `jobWorkflowRef` 时核对 SHA 固定的 `job_workflow_ref`。省略 `jobWorkflowRef` 表示只约束调用方 workflow。允许的 GitHub 事件是 `push`、`workflow_dispatch` 和 `release`。配置中的 workflow ref 按 GitHub claim 的实际拼写填写。

登记过的包要求 OIDC bearer 或市场管理员凭据。公开来源里其余包仍可匿名提交。无效或缺少 JWT 返回 `401 github-oidc-invalid`，身份未授权返回 `403 github-oidc-publisher-denied`，无法读取验证密钥返回 `503 github-oidc-unavailable`。公开回执仍可匿名查询。管理 API 的 `githubPublisher` 记录首次接收时的 workflow ref、run ID 与 attempt，历史回执和通过其他凭据接收的记录为 `null`。同一坐标复用原记录。

调用方示例见 [GitHub Actions](../../docs/development/plugin-market.md#github-actions)。需先应用 D1 迁移再部署此 Worker。OIDC 处理通知者身份，发行的 npm provenance 由制品验证链处理。

## 独立网页与官网挂载

启动现有市场服务后直接访问市场根地址，例如 `http://127.0.0.1:8787/`。Wrangler Workers Static Assets 与本地 Miniflare 使用同一 `dist/web`；`/v1` 和 `/admin` 保持 Worker 处理，未找到的路径不会回退成首页。`dev` 和 `dev:sandbox` 启动前通过同一个 `compile-web` 任务构建网页，无独立前端服务。

网页与 Workbench 复用 `@pluxel/plugin-package-manager/marketplace` 的纯 React 浏览组件。网页直接匿名读取公共 HTTP，不创建 Workbench、Cap’n Web 会话或安装/管理权限；私源目录仍不会向匿名网页公开。

仅导出静态站点时，在本目录执行：

```sh
VITE_MARKET_URL=https://market.example.com vp run build:web
```

将 `dist/web/` 整体挂到官网的根目录或带末尾 `/` 的子目录即可；资源 URL 使用相对路径。构建时的 `VITE_MARKET_URL` 选择公开市场 API 地址，省略时使用网页当前 origin。这里不接收 token，也不把本地沙箱凭据打包进网页。站点可独立托管，运行时不依赖源码工作区；跨域目录读取由市场已有的公开 CORS 契约支持。

## 只读镜像

在本目录执行 `vp run build:mirror`，把独立产物 `dist/mirror.mjs` 复制到有 Node 24 的目标服务器。镜像使用本地 SQLite，数据库目录需要持久化并允许 SQLite 写入事务日志。

```sh
node mirror.mjs sync https://market.example.com ./catalog.sqlite
node mirror.mjs serve ./catalog.sqlite
```

`sync` 是一次性操作。将同一条同步命令交给部署环境的定时任务即可。命令携带已提交快照的 ETag 请求[快照接口](#http-契约)。收到 `304` 时跳过导入，收到新快照时在一个 SQLite 事务中替换整个目录。同步失败会以非零状态退出，镜像继续读取上一次提交的完整目录。主站隐藏包或调整公开来源后，镜像在下次成功同步时采用新目录。

`serve` 默认监听 `127.0.0.1:8787`，可用 `HOST` 和 `PORT` 设置监听地址。服务只读本地文件，主站离线时仍可搜索、筛选、查看包和发行。跨区域无法直接同步时，可在能访问主站的环境中对专用文件执行 `sync`，命令退出后将该文件连同构建产物复制到目标环境。更新这类部署时，用新文件启动镜像。升级镜像程序时，先用新版同步，再用同一版程序启动读服务。

网页的 `VITE_MARKET_URL` 和 Workbench 的 `markets[].url` 可指向同一个镜像地址。镜像提供公开目录，插件及依赖仍由 pnpm 从部署配置选择的 registry 下载，安装继续核对原始来源、精确版本与发行摘要。主站负责管理与通知。

## 目录观测与发行检查

- `observe({ registry, name })` 读取真实 registry packument，保存 latest 对应的描述、README、license、repository 和 dist-tags，返回 `observed`。它不核验 tarball、不生成发行或成功通知；适合先检索、查看尚未兼容当前 Host 的已发布包。
- `refresh({ registry, name, version })` 下载精确版本 tarball，核对 SHA-512、包名、版本、包内公开文件和依赖后提交发行，成功才返回 `indexed`。发行 README 来自已核对制品。

`latest` 始终来自上游 dist-tag，即使对应发行未通过检查也不回退。目录元数据与已收录发行分别表达事实；`metadataVersion` 指明 README、license 对应的元数据版本。`coverage: "indexed-only"` 表示发行列表只覆盖已检查版本，不是上游完整历史。

包声明的 HTTPS `repository` 供浏览使用。`refreshRepository({ registry, name })` 从 GitHub 观测该仓库的星数与归属，记录 `repositoryStars`、`repositoryObservedAt` 和作者 ID。GitHub 账号按数字 ID 归组，名称与头像来自最近的有效观测。失败保留该仓库的旧观测，包变更声明仓库时清除旧归属和星数。

包摘要和概览的 `author` 为市场登记的作者，或包声明的 GitHub 仓库 owner。两种身份分别以 `market:` 与 `github:` 开头，市场登记优先。无记录时为 `null`，有记录时头像仍可为空。目录读取使用已存储的归属，发行 provenance 由具体发行携带。

刷新失败保留已有记录；同一发行出现不同摘要时，观测、发行和审计整批拒绝。`observedAt` 是 registry 请求开始时间，API 的 `200` 或 `304` 不表示刚刷新上游。

## HTTP 契约

目录 DTO 位于 [src/protocol.ts](src/protocol.ts)，由 Worker、镜像与工作区调用方共同演进。包名和精确版本各编码为单个路径段。列表默认 20 条，`limit` 为 1–50；错误使用 `application/problem+json` 与稳定 `code`。

| 操作                                                       | 返回与边界                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /v1`                                                  | `protocolVersion: 1`、可读来源及能力，不返回凭据                                      |
| `GET /v1/packages`                                         | `{ packages, nextCursor }`，按名称、来源排序                                          |
| `GET /v1/facets`                                           | `{ total, registries, categories, tags, authors }`，计数基于分页前的可见目录          |
| `GET /v1/packages/:name?registry=`                         | 摘要、dist-tags、元数据 README/license/version、已收录数量及 coverage                 |
| `GET /v1/packages/:name/releases?registry=&cursor=&limit=` | 已检查发行分页摘要，按版本字符串排序，不代表 semver 新旧                              |
| `GET /v1/packages/:name/releases/:version?registry=`       | 精确来源、tarball、integrity、依赖、制品 README/license 及 provenance                 |
| `GET /v1/snapshot`                                         | 主站的公开目录快照，`version: 1`，含公开来源、可见包、有效作者和已检查发行            |
| `POST /v1/notifications`                                   | `{ registry, name, version }`；持久接收后 `202` 与 `Location`，终态重复提交返回 `200` |
| `GET /v1/notifications/:id`                                | 回执状态；查询成功与收录成功分别表达                                                  |
| `POST /admin`                                              | Bearer 认证的原生 Cap’n Web HTTP batch                                                |

目录列表和筛选选项都接收 `query`、`official`，以及可重复的 `registry`、`category`、`tag`、`author`。每组最多 20 个值，组内任意命中、组间同时命中。结果总数应用全部条件，单组选项计数应用搜索和其他组条件。隐藏包与当前请求无权读取的来源都排除在统计和结果外。仅包列表接收 `cursor` 和 `limit`。

精确包和发行查询默认选择公共 npm。FTS5 匹配包名、描述和市场标签的词前缀，多词同时满足。游标绑定归一化查询和可读来源，改变筛选需从头开始。分页读取当前视图。

公共目录支持 `ETag` / `If-None-Match`，缓存最长 30 秒。认证响应、通知、管理和错误响应使用 `no-store`；目录返回 `Vary: Authorization`。隐藏不撤销已下载制品。时间戳为 Unix 毫秒。

快照对应一个 D1 读事务，始终使用匿名可见性。编码后的响应上限为 16 MiB，超出响应预算时返回 `503 snapshot-too-large`。包列表、分面与发行接口共用主站的读取实现。镜像在 `GET /v1` 中声明 `notifications: false`。

## 市场管理

[MarketAdmin](src/admin.ts) 使用原生 Cap’n Web batch；当前管理入口为 CLI 与 API。[examples/admin.ts](examples/admin.ts) 可直接体验：

```sh
# 在本目录执行，本地沙箱会话自动提供地址与管理员凭据
node examples/admin.ts observe @pluxel/fonts
node examples/admin.ts package @pluxel/fonts
vp exec node examples/admin.ts catalog '{"official":true,"categories":["integration","development"]}'
node examples/admin.ts notifications '{"status":"failed","limit":20}'
```

私源操作加 `--registry <base>`；显式设置 `MARKET_URL` 时同时提供 `MARKET_ADMIN_TOKEN`。每个 batch 创建新 session，以 `using` 释放。接口包括：

- `observe` / `refresh` / `refreshRepository`：显式刷新上述独立事实。
- `getPackage({ registry, name })`：观测、人工元数据、隐藏状态与 revision。
- `setMetadata({ registry, name, expectedRevision, official, category, tags, author? })` 编辑市场标记与署名。分类可为 `null`，分类和标签使用最多 32 字符的小写 slug，最多 20 个不同标签。`author: { id: "market:team", name: "Team" }` 为包登记作者，同一 ID 共用显示名。用 `author: null` 清除登记，省略该字段只编辑市场标记。
- `setVisibility({ registry, name, expectedRevision, hidden })`：与元数据编辑共享 revision；上游刷新不覆盖人工输入。冲突返回实际 revision，不生成成功审计。
- `listNotifications({ registry?, name?, status?, code?, cursor?, limit? })`：按创建时间、ID 倒序检索。
- `getNotification(id)` / `retryNotification(id)`：回执、内部诊断和重试决策，不暴露租约，不重置尝试预算。
- `processNotifications()`：处理最多 10 条待办，与五分钟 Scheduled Handler 相同。
- `recentChanges({ registry, name })`：最近 20 次刷新、人工编辑及变更内容。

人工修改及审计在同一 D1 batch 条件提交。目录观测不会将未核验发行变成可安装版本，也不会使旧失败通知成功。

## Provenance 边界

**CI 通知的自动收录尚未启用。** 原生 Sigstore 在 workerd 的 `nodejs_compat` 中未通过真实有效 npm provenance 正例，复现见 [Worker 可行性实验](../../engineering/spikes/plugin-market-worker/README.md#provenance-阻塞与最小复现)。项目没有关闭检查或补丁绕过。

`GET /v1` 返回 `capabilities.provenanceVerification: false`。通知持久去重，处理后明确以 `provenance-runtime-unsupported` 失败；已知运行时问题不会通过重试或反复下载掩盖。npm 发布成功、通知 `202`、市场收录是三个结果。

手工 `refresh` 只接纳未声明 attestations 的发行；存在证明时同样失败，不降级成 `missing`。`observe` 可展示这类包的元数据，但不生成已检查发行。自动收录仍需实际 workerd 的 Sigstore 正负例、部署维护的 TUF 刷新，以及有效租约与目录写入的同一条件提交。

## 制品、容量与迁移

- 精确元数据和包内 `package.json` 各最多 512 KiB，目录 packument 最多 2 MiB；README 预览有界，返回 `truncated`。压缩 tarball 最多 16 MiB，展开最多 64 MiB、2048 条。一次 npm 操作共用 30 秒超时，一个 isolate 同时检查一个制品，繁忙返回可重试的 `refresh-busy`。
- tar parser 拒绝越界、重复路径、链接、特殊文件和缺失公开目标，不执行脚本或导入 JavaScript。当前检查 `@pluxel/core` peer、显式 JavaScript exports、`pluxel.pluginPackages` 及 optional 标记；不支持通配 exports，不代表 Host 最终兼容或启用成功。
- 通知正文最多 4 KiB，管理 batch 最多 64 KiB。通知最多保留 5000 条，每分钟最多 100 条新增，每来源内的包最多 10 条活跃任务；满额返回 `429`。重复坐标复用保留期内回执。
- 租约 60 秒，最多三次尝试；过期执行不能提交。终态回执保留至少七天，定时清理最多 100 条。定时任务不扫描 npm 全站、不自动刷新 tags 或 GitHub；目录保存已检查发行事实。

```sh
vp run @pluxel-internal/plugin-market#check-types
vp run @pluxel-internal/plugin-market#check-tests
vp run @pluxel-internal/plugin-market#compile
vp run @pluxel-internal/plugin-market#compile-mirror
```

测试使用本地 workerd、D1 和受控上游响应。镜像验收从 Worker 拉取快照，用仓库之外可运行的产物与本地 SQLite 验证目录一致性、同步回滚和离线读取。PNPR 验收另执行真实本地构建发布。

Drizzle schema 维护结构，`vp run db:generate` 生成迁移；FTS5 由显式 custom SQL 迁移维护。Wrangler 拥有迁移应用；测试验证从有数据旧 schema 升级、外键及重复应用。Wrangler、Miniflare 和 Workers types 固定为经过验证的组合，升级时一起重跑。
