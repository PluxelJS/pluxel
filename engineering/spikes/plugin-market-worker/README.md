# Plugin Market Worker Spike

验证日期：2026-11-05。范围：[市场基础提案](../../proposals/plugin-distribution/README.md)的运行可行性；产品初版与当前支持范围见 [Worker 项目](../../../projects/plugin-market/README.md)。

已跑通本地 workerd、D1、标准 HTTP 通知及 Cap’n Web HTTP batch 管理调用。真实 npm provenance 在 Node 对照中通过，在当前 workerd 中失败；自动验证收录仍有明确阻塞。
本目录是独立、私有的实验项目，依赖和 lockfile 就地锁定，不进入框架发布图或根验证任务。这里的表、路由和管理方法不是公开市场 API。

## 已验证结果

| 边界           | 实际结果                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------ |
| 通知与回执     | 并发重复通知只创建一个待办；HTTP 返回 `202` 和 `Location`，重建 Worker 后仍可查询同一回执        |
| 输入与来源     | 仅接受固定公共 npm 来源、有效包名和精确版本；拒绝额外 tarball URL，失败使用 HTTP Problem Details |
| 管理传输       | 原生 Cap’n Web 客户端通过真实本地 HTTP 调用 workerd；错误凭据在暴露 target 前被拒绝              |
| 并发修改       | 相同预期版本的两个编辑只有一个成功；关联操作记录也只提交一次，过期编辑不留下操作记录             |
| D1 原子批次    | 后续 SQL 违反唯一约束时，前面的修改回滚；零行 CAS 使用条件关联写入，不依赖异常回滚               |
| 任务领取       | 并发领取只成功一次，租约到期后可重新领取；旧 token 和已到期结果不能提交                          |
| 迁移           | Drizzle Kit 生成 SQL；Wrangler 在空本地 D1 上应用成功，再次执行报告无待应用迁移                  |
| 打包和类型     | Wrangler dry-run 打包、TypeScript 检查通过；没有部署到远端                                       |
| npm provenance | `capnweb@0.12.0` 的原生证明在 Node 对照中通过，workerd 正例失败，后续篡改负例尚未验证            |

普通回归共 8 个用例。D1 租约用例通过公开 D1 binding 代理执行真实 SQL；尚未接入 Scheduled Handler，也未证明远端 D1 的并发、性能和限制。

## provenance 阻塞与最小复现

网络实验从 npm 拉取 `capnweb@0.12.0` 的真实 tarball 与 attestation。Node 侧使用原生 `@sigstore/tuf`，从其内置 TUF bootstrap root 开始获取并验证 Sigstore 信任材料；随后将原生数据交给 workerd 中的 `@sigstore/verify`。
此处 Node 负责实验准备，签名和 tarball 摘要检查在 Worker probe 中执行。生产环境的信任根供给、刷新和失效策略尚未实现；真实通知端不能接受调用方提供的信任根。

固定样本在原生 Node 中通过证书、透明日志及制品绑定验证。更换包名、版本、tarball 或签名 payload 均被拒绝。相同正例在 workerd 中报 `inclusion promise could not be verified`，替换为 `workerd 1.20261121.1` 复测仍失败。用本地生成的 ECDSA P-256 密钥和 SHA-256 签名可以复现：

| 调用                                             | Node 24.16.0 | workerd 1.20261103.1 + `nodejs_compat`      |
| ------------------------------------------------ | ------------ | ------------------------------------------- |
| `crypto.verify('sha256', data, key, signature)`  | `true`       | `true`                                      |
| `crypto.verify(undefined, data, key, signature)` | `true`       | `Failed to initialize verification context` |

`@sigstore/core@4.0.1` 的验证路径使用省略算法的调用，并将该异常转为 `false`，上层因此报告 inclusion promise 失败。
保留正例门禁与最小复现；解决上游兼容或验证受支持的原生接入方式后，重新执行完整正负例。当前没有修改上游包、替换密码实现或关闭透明日志检查。
这证明该锁定组合不能直接完成此样本的校验，不代表所有 Workers 版本或所有 Sigstore 接入路径均不可用。

## 复现

在本目录使用 Node 24 与 pnpm 11.28.10：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm db:migrate:local
pnpm db:migrate:local
pnpm build
```

`build` 仅执行 Wrangler `--dry-run`。测试自管临时 workerd 和数据库，退出时关闭进程并清理自己的目录；迁移命令的本地数据库位于已忽略的 `.wrangler/`。

以下是当前明确失败的可行性门禁，单独执行，不伪装为已通过：

```sh
pnpm test:crypto
pnpm test:provenance
```

`test:crypto` 使用本地密钥。`test:provenance` 从 npm 与 Sigstore TUF 读取公开样本。Node 和 workerd 分别执行同一组正例及替换包名、版本、tarball 和签名 payload 的负例，每组先验证正例。
样本是有 provenance 的普通 npm 包，并非已经符合新 manifest 格式的 Pluxel 插件。实验入口接受测试数据，仅用于隔离本地执行。

主要版本由本目录 `package.json` 与 lockfile 拥有：Drizzle ORM 0.45.4 / Kit 0.31.11、Cap’n Web 0.12.0、Wrangler 4.157.0、其同版 Miniflare 5.20261103.0-beta、Sigstore Verify 4.1.2。
Miniflare 使用该锁定版本的 `workers[].config` 原生入口；不能直接复制 v4 的顶层 `script` 配置。

## 下一步与未覆盖范围

下一步先解决并复验 Worker 原生验证路径，再从标准 build 生成一个真实 Plugin manifest，连接通知、拉包、校验、目录提交与查询。
本实验不包含发行目录、tarball 解包与 manifest 校验、Cron 调度、自动重试策略、流量与容量控制、私有 registry、生产认证、后台页面或安装器；不代表产品初版的支持范围。
实验中的单 token 管理认证和硬编码来源仅用于验证传输边界；回执接受成功不表示包已验证或收录。

## 参考市场接入后的框架反馈

参考实现用 Vite 编译 Pluxel 的语义构建产物，将请求和 Cron 交给 `@pluxel/host/cloudflare`。关闭 Node 兼容开关后，workerd 能执行 `MarketPlugin` 的 HTTP、D1、R2、Web Crypto 和流式 tar 解析。轻量 Host 入口将平台能力交给市场，构建与测试检查 Node 依赖是否进入 Worker 产物。[Worker 装配](../../../projects/plugin-market/src/worker.ts) · [workerd 验收](../../../projects/plugin-market/tests/worker.test.ts)

- 当前 `MarketBindings` 直接使用 Cloudflare 类型。出现第二个写入宿主时，优先按已有行为定义业务存储契约，并让 Node 与 Worker 实现跑同一组测试。验收包括发行不可改写、摘要一致、冲突不留成功审计和回执租约失效。只读镜像已经用 Node/SQLite 复用目录协议。
- Host 的 SDK 借用在插件方法拒绝时提供控制面错误包装。HTTP 业务在所属插件内把可预期失败转换成正确状态码和稳定错误码；请求入口只负责装配和转发。未来如果多个 Worker 应用需要同样的适配，再从实际调用提炼通用入口。
- 证明验证需要保留本页的真实正负例作为接纳条件。可单独为验证选择支持其密码 API 的运行时；调用契约仍绑定 registry、包名、版本和 tarball 摘要。验证服务不可用时保持现有失败回执。

市场增强可以按刷新边界组合。压缩大小、解包字节数、直接依赖数和许可证来自校验后的制品。完整安装大小和传递依赖数量需要指定解析器、依赖版本视图和目标平台。漏洞结果需要绑定具体版本、来源和查询时间，查询缺失或失败显示未知。README 图片与仓库信息也可由观测插件提供，使用声明的来源及可控的请求预算。外部观测单独刷新、标注测量时间与方法，避免堵住发布和目录提交；只有运营方明确选择准入规则，才由审核返回可审计的决定。现有实现提供制品大小与可配置审核，尚未添加外部观测任务和字段。[npmx 功能与数据来源](https://docs.npmx.dev/guide/features)

上游依据：[Miniflare D1](https://developers.cloudflare.com/workers/testing/miniflare/storage/d1/)、[D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)、[Workers Node crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)、[Sigstore TUF](https://github.com/sigstore/sigstore-js/tree/main/packages/tuf)。
