# 插件市场 Worker 初版

这是独立的 Cloudflare Worker + D1 项目，提供给 Package Manager 插件使用的市场 HTTP API。它不启动 Pluxel Host，也不负责安装或运行插件。市场链接是安装插件的可选配置；不连接市场仍可直接安装。

当前可用链路是：管理员通过 Cap’n Web 登记精确 npm 发行，Worker 拉取真实 npm 元数据与 tarball，核对 SHA-512、包名、版本、包内公开入口及依赖声明，提交 D1 后供插件查询。读取 API 不访问 npm。来源只支持 `https://registry.npmjs.org`，不接受请求者提供的 registry、tarball 或仓库替代地址。

## 本地运行

在仓库根完成依赖安装后：

```sh
cd projects/plugin-market
vp run db:migrate:local
```

在本目录的 `.dev.vars` 中设置 `ADMIN_TOKEN`，然后运行 `vp run dev`。本地默认地址由 Wrangler 输出；该文件已忽略，不提交凭据。默认 Wrangler 配置的 D1 ID 仅供本地运行，远程部署前由部署方创建自己的 D1、配置实际 ID、通过 `wrangler secret put ADMIN_TOKEN` 保存密钥，再显式应用远程迁移。此初版没有执行远程部署。

管理员脚本从本目录运行：

```sh
MARKET_URL=http://127.0.0.1:8787 node examples/refresh.ts @acme/pluxel-plugin-orders 1.0.0
```

脚本另外读取 `MARKET_ADMIN_TOKEN` 环境变量。它只在 `refresh` 完成 tarball 检查并提交后返回 `indexed`；失败包含稳定 `code`、可读 `message` 和 `retryable`。认证使用 `Authorization: Bearer …`，公开目录不需要凭据。

## HTTP 契约

当前 TypeScript DTO 位于 [src/protocol.ts](src/protocol.ts)，仍是初版协议；Worker 与安装插件共同演进。名称和精确版本都使用 `encodeURIComponent` 编码为一个路径段。请求错误使用 `application/problem+json`，包含稳定 `code`；列表默认 20 条，`limit` 范围 1–50。

| 操作                                             | 返回与边界                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1`                                        | `protocolVersion: 1`、固定 npm 来源和能力状态                                                                                   |
| `GET /v1/packages?query=&cursor=&limit=`         | `{ packages, nextCursor }`；按 npm 包名包含匹配和名称排序；只返回可见记录                                                       |
| `GET /v1/packages/:name`                         | 包描述、实际 `distTags`、来源观测时间；`coverage: "indexed-only"`                                                               |
| `GET /v1/packages/:name/releases?cursor=&limit=` | 已收录版本的分页摘要，按版本字符串排序；该顺序不表示 semver 新旧                                                                |
| `GET /v1/packages/:name/releases/:version`       | 固定 `registry/name/version/tarball/integrity`、依赖事实和 provenance 状态                                                      |
| `POST /v1/notifications`                         | JSON `{ "registry": "https://registry.npmjs.org", "name": "@acme/plugin", "version": "1.0.0" }`；持久接收后 `202` 与 `Location` |
| `GET /v1/notifications/:id`                      | 公共回执；待处理、处理中、已收录、失败独立于 HTTP 查询是否成功                                                                  |
| `POST /admin`                                    | 认证后的原生 Cap’n Web HTTP batch                                                                                               |

目录读取支持 `ETag` / `If-None-Match`，公共缓存最长 30 秒。游标绑定查询，修改查询时重新开始；分页反映每次请求的当前视图，不保留历史快照。通知、管理与错误响应使用 `no-store`。所有时间戳是 Unix 毫秒。

`latest` 始终来自 npm dist-tag；即使它尚未收录也不会退回最高或较旧版本。未收录发行返回 `404`，用户仍可显式选择已有版本。`observedAt` 表示 npm 获取开始时间，API 的 `200` / `304` 不意味着刚刚刷新上游。刷新失败保留旧观测和发行；同名同版若出现不同摘要，整批观测、发行及审计写入全部拒绝。

`repository` 只用于已验证 provenance 的仓库；当前所有可收录发行均返回 `null`，作者在 `package.json.repository` 中填写的 URL 不构成来源验证。

## 最小管理接口

[MarketAdmin](src/admin.ts) 直接使用 Cap’n Web 原生 batch，不额外建立管理 REST、MCP 或管理后台。人和 coding agent 可以使用同一类型化 API：

- `refresh({ registry, name, version })`：读取并核对精确发行，然后提交目录。
- `getPackage(name)`：读取观测与人工可见性 revision。
- `setVisibility({ name, expectedRevision, hidden })`：条件更新人工可见性；冲突返回实际 revision，npm 刷新不覆盖它。
- `getNotification(id)` / `retryNotification(id)`：读取内部诊断或请求有界重试；不重置尝试预算，已知运行时不支持的证明不会重新入队。
- `processNotifications()`：执行一批最多 10 条待办，与每五分钟的 Scheduled Handler 相同。
- `recentChanges(name)`：读取最近 20 次人工刷新或可见性修改的审计。

每个 HTTP batch session 只提交一批调用，等待该批完成后需要创建新的 session；例子使用 `using` 释放原生 stub。可见性修改的审计与 revision 条件更新在同一 D1 batch 中提交，竞争失败不会生成虚假的成功审计。

## 证明能力的明确边界

**CI 通知的自动收录尚未启用。** 当前原生 `@sigstore/verify` / `@sigstore/core` 组合在 workerd 的 `nodejs_compat` 中无法通过真实有效 npm provenance 的正例，问题和复现见 [Worker 可行性实验](../../engineering/spikes/plugin-market-worker/README.md#provenance-阻塞与最小复现)。此项目没有打补丁或关闭校验绕过它。

`GET /v1` 因此返回 `capabilities.provenanceVerification: false`。通知仍提供真实的持久去重回执，调度后以 `provenance-runtime-unsupported` 失败；调度不重复请求 npm 消耗下载与重试预算。已有手工收录也不能使 proof-required 通知成功。CI 在 npm 发布成功后可通知并检查回执，但不能将 `202` 当作上架成功。

管理员手工收录只接纳 npm 元数据没有声明 attestations 的发行。存在 attestations 时同样明确失败，绝不降级成 `missing`。启用自动收录前仍需完成：原生 Sigstore 在实际 workerd 上的有效证明正例、无效签名/错误 subject/摘要的负例，部署维护的 TUF 信任材料刷新，以及与目录提交相同的有效租约条件提交。请求不能提供自己的信任根。

## 制品与成本边界

- 精确版本元数据与包内 `package.json` 各最多 512 KiB；压缩 tarball 最多 16 MiB；展开最多 64 MiB、2048 个条目。每次 npm 操作共用 30 秒超时。一个 Worker isolate 同时检查一个制品，额外刷新返回可重试的 `refresh-busy`，限制下载与摘要计算的瞬时内存。
- npm 请求只允许固定 HTTPS origin，不跟随重定向，不接受凭据、query 或 fragment。标准流式 tar parser 检查压缩包；包内路径必须留在 `package/`，拒绝重复路径、链接、特殊文件以及缺失的公开目标文件。不执行包脚本或导入 JavaScript。
- 初版检查现有发布元数据：`@pluxel/core` peer、显式公开 JavaScript exports、`pluxel.pluginPackages` 与 peers/optional 标记一致。暂不支持通配 exports。新的独立 Plugin manifest 仍在提案中，不能将这些检查当作已实现该格式或证明 Host 兼容；最终发现、接纳与生效由安装插件和 Host 决定。
- 匿名通知正文最多 4 KiB；管理 batch 最多 64 KiB。通知原子准入限制为最多 5000 条保留回执、每分钟 100 条新增、每包 10 条活跃任务。重复坐标复用原回执；满额返回 `429` 与 `Retry-After`。
- 租约为 60 秒，最多 3 次尝试；可恢复故障退避重试，过期租约结果不能提交，最后一次崩溃也会结算为失败。终态回执保留至少七天，定时批量清理最多 100 条；过期后原坐标可产生新回执。
- 定时任务目前只处理通知和回执保留。npm 搜索发现、自动 tag 复核和历史补录未启用；管理 `refresh` 是当前显式刷新入口。目录永久保存已核对的发行事实。

## 验证与迁移

```sh
vp run @pluxel-internal/plugin-market#check-types
vp run @pluxel-internal/plugin-market#check-tests
vp run @pluxel-internal/plugin-market#compile
```

测试使用真实本地 workerd 与 D1，并在网络边界提供受控 npm 元数据和真实 gzip tarball。覆盖手工收录到 HTTP 读取、摘要与包内文件拒绝、证明 gate、禁止重定向、发行冲突事务、分页、ETag、CAS、匿名容量、租约恢复和 Worker 重建后的持久回执。它不使用远程 D1，也不宣称完成真实 npm provenance 验证。

Drizzle schema 维护表结构，`vp run db:generate` 产生迁移；Wrangler 拥有 D1 迁移应用。`compile` 只执行 Wrangler dry-run，不发布 Worker。修改 schema 后提交生成的 SQL 与 metadata，并在空本地 D1 验证应用和重复应用。

Workspace catalog 中 Wrangler、Miniflare 与 Workers types 使用精确版本，原因是这组组合已经通过本项目真实 workerd / D1 验证；Miniflare 5 的配置结构与旧版不同，不能只按范围升级后假定行为兼容。升级应同时更新组合并重跑本项目检查与已有 provenance 正负例。

原生能力依据：[npm Registry API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md)、[Cloudflare Web 标准](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)、[modern-tar](https://github.com/ayuhito/modern-tar)。
