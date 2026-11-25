# 自动收录与目录复核

明确启用 `unsigned` 的私有来源已经可以自动收录无证明发行。Worker 领取通知、拉取并审核精确版本，在同一 D1 事务中核对有效租约和发行摘要，写入目录、审计和成功回执。声明了 attestations 的发行目前返回 `provenance-runtime-unsupported`。[通知处理](../../../projects/plugin-market/src/indexing/jobs.ts) · [条件提交](../../../projects/plugin-market/src/indexing/commit.ts) · [Worker 的证明边界](../../../projects/plugin-market/README.md#provenance-边界)

## CI 发布通知与 npm provenance

1. 部署方先用真实有效的 npm provenance 在目标 workerd 验证原生 Sigstore，分别篡改包名、版本、tarball 和签名 payload 时应拒绝。目标部署还需确定 TUF 信任根的来源、刷新和失效策略，包括网络不可用时的处理。[当前阻塞与复现](../../spikes/plugin-market-worker/README.md#provenance-阻塞与最小复现)
2. 将通过验证的证明绑定到本次审核的发行坐标和 tarball 摘要，从证明中取得可展示的仓库、commit 和构建信息。沿用现有租约与目录提交事务，只有证明记录和发行一起保存后才完成通知。已人工收录的相同字节也需补验，已存在的摘要与新字节冲突时拒绝。
3. 用真实 Plugin 验证通知响应丢失、证明稍后才可读和提交时租约已过期。暂时读取失败可在同一通知预算内重试，证明无效时结束该次处理并保留已提交目录。CI 发行成功、通知已接收与目录已收录各有自己的结果。

## 发现与复核

补漏从已登记的完整包名、通知、已有目录或 registry 支持的关键词查询获取候选。包名前缀和 `pluxel-plugin` keyword 只用于发现。通知与扫描复用精确发行的拉取、审核和按来源选定的证明策略。公开目录读取只查询已提交结果。

持续扫描需要限制每轮包数、并发和时间，为通知与复核各自保留处理机会。按来源能力使用 ETag、Last-Modified 和已知摘要，第二轮可复用未变的观测。过期观测不能覆盖更新的 tag 或人工编辑，单包超限不能阻塞下一包。按批保存进度，恢复后从已提交的批次继续。[现有通知预算](../../../projects/plugin-market/README.md#制品容量与迁移)

## 版本覆盖与来源可用性

现有目录保留真实上游 tag，`coverage: "indexed-only"` 表示实际检查过的版本。扫描优先处理通知指定的发行和 tag 目标，再按预算回填历史。请求超时、候选待处理和确认撤回需由生产端分别记录。确认撤回须有 registry 的直接观测，保留既有发行摘要和验证历史。已安装 Plugin 的运行状态由 Host 报告。[目录消费](index-protocol.md#版本选择与新鲜度)
