# 是否删除 Plugin fork

状态：Redis/S3 验证性迁移已完成，**Core/Host 的 fork 删除尚未采纳、尚未开始**。当前身份与生命周期仍以 [Plugin Identity](../PLUGIN_IDENTITY.md) 和 [Host](../HOST.md) 为准。

## 决策与证据

问题是同一 concrete definition 的多实例是否值得成为通用 framework contract。Fork 隔离 node 的配置、依赖选择、generation、effects 与运行意图，但共享代码、HMR 与进程；它不提供独立版本、安全、扩缩容或故障隔离。

仓库原有生产采用面集中在 Redis connections 与 S3 buckets；两者已改成 producer-owned bounded config catalog。Synthetic tests 证明 fork 实现，不证明产品需要。删除的主要收益是去掉 durable definition/node 双身份，而非未经测量的启动/吞吐提升。

保留 fork 的真实用例须同时满足：

1. 必须成为 Core graph node，普通 record/handle/Part 无法表达失败与生命周期。
2. 创建权属于 Host，而非领域 producer。
3. 每个实例需要不同上游 Plugin graph，不只是 endpoint/credential 等数据不同。
4. 数量持久、有界，不是可增长的 tenant/account collection。
5. 接受同代码、同进程，不要求独立部署隔离。

当前尚无生产用例证明这个交集。发现满足条件的调用方，或发现 node 另有不可替代的持久身份含义，必须重新评估删除。

## 若采纳的目标

- Concrete definition 最多有一个 transient runtime record/current generation，abstract definition 不物化。
- Config、state、logging、RPC/URL、Workbench 与 persistence 都以 definition 为唯一 durable owner。
- 删除 public/persisted `PluginNodeAddress`、`PluginNodeSlot`、variant/forkId、对应 codecs 及 definition-to-many-nodes family；不保留 fork-ready 一对一 identity。
- 内部仍可保留承载 instance、Context、effects/admission 的运行记录，但只由 definition slot 定位。
- 动态多实例由 producer 的领域 collection 管理；固定业务角色用多个 concrete definitions，共享普通实现；独立部署/故障边界用独立 Host/process。
- 保留 optional integration 与 abstract provider selection；它们解决 provider availability/implementation，不选择 collection item。
- 不增加通用 Profile、named-instance SPI、Runtime collection store 或 synthetic item graph。

只删除按钮/作者入口而保留双 durable identity，不满足本提案。若无法完整收缩，应保留当前 fork 或重新决策。

## 已完成的验证性迁移

| Producer | 当前已实施边界                                                                                                                                              | 没有实施                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Redis    | 1–64 唯一 connection IDs；并行 connect，全 catalog 原子成功/回滚；`connection(id)` 返回 consumer/provider-bound handle；Cache/Rates 保存自己的 connectionId | 运行期 create/remove、通用 profile registry   |
| S3       | 1–64 唯一 bucket IDs；每项选择 local/remote/anonymous/vault；并行初始化、原子 generation；`bucket(id)` 返回 owner-bound client，Vault 引用属于 bucket       | 动态 store control plane、synthetic lifecycle |

两者使用固定 Workbench Content 展示有界 rows，item 数量不改变 entry/root/socket；配置变更走普通 generation replacement。源码与用法分别位于 `plugins/redis/`、`plugins/storage/`。这说明已知用例可脱离 fork，不能证明所有第三方需求也可迁移。

Consumer 拥有 stable item ID 的保存与 missing/unhealthy/rebind/fallback policy。Producer 不扫描并重写 consumer，不静默选择第一个 item。Handle 必须明确 cached use、remove、provider replacement、abort 和 in-flight drain；这些是领域协议，不统一成 CRUD 或 framework status。

## 删除与迁移范围

采纳后需一次 inventory 覆盖：

- decorator/lowering/candidate forkability、Core address/slot/records/family、definition replacement；
- Host durable forks、coordinator create/remove、provider/consumer selection、auto-start/session；
- Config、logging、database/Vault/cache 等 owner namespace、Management RPC/catalog、Workbench、reference/route；
- static/dynamic/Vite/test host、demo、benchmarks、public exports、用户文档与发行契约。

Default-only state 可机械收缩；存在 fork 的 profile 必须先列出 config、依赖引用、auto-start 与 logging policy。Redis/S3 需要明确一次性转换到领域 catalog/consumer selection；未知第三方 fork 无法证明等价时拒绝并要求显式迁移。新 runtime 只读新 schema，转换是离线工具，不永久保留双读/alias。未完成验证前不得改写真实持久数据。

## 采纳 gate

1. 重新审计真实 workspace/下游，不存在上述五项联合需求。
2. Redis/S3 多 item、并发、cached handle、replacement/abort/cleanup 回归成立，没有复制通用 graph/coordinator。
3. Optional 与 abstract selection 在 static、dynamic、Vite/HMR、test host 上保持语义。
4. 完整 identity inventory 证明可删除所有 public/persisted node/family 协议。
5. Default-only、已知 Redis/S3 与未知第三方状态分别有可操作的迁移/拒绝路径。
6. 完成后没有 profiles、hidden forks、legacy codec 或第二套多实例 contract。

若 collection 必须复制 blocked closure/lifecycle coordinator，或独立 definition/Host 带来真实不可接受成本，应否决或修改提案。性能结论需实际测量；不用减少行数替代 ownership 验证。

未决问题是第三方迁移归属、fork 以外的 node identity 用例，以及真实 consumer 的 rebind/反向引用需求。采纳后先冻结 inventory 和迁移设计，再在明确 breaking release 中同步删除；当前文档整理不授权实现该提案。
