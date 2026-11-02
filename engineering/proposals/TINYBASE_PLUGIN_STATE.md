# TinyBase 状态重构决策索引

状态：已实施。更新：2026-11-02。本页记录本轮确定的数据归属与验收边界；当前 API、实现和验证入口由下列权威文档维护。早期方案与阶段性验收保留在 Git 历史和[迁移记录](../TINYBASE_MIGRATION.md)，不作为当前配置依据。

## 当前决策

1. **文件后端统一装配。** Host 在 `runtime.zenfs` 选择后端；Core 独立入口使用 `zenfs`。省略时每个 Core 使用独立 InMemory。Core 拥有创建的资源及关闭排空，借入资源仍由调用方释放。只读与持久性要求按实际目标目录检查。见 [FS](../FS.md)。
2. **TinyBase 只管理 Plugin Store。** 每个 canonical Plugin node（含 fork）有一份托管原生 Store，Part 共用所属 Plugin 的 handle。作者直接使用上游 API，Core 负责恢复、完整快照保存、publication、故障和生命周期；`runtime.tinybase` 只设置 Plugin snapshot 预算。见 [TinyBase](../TINYBASE.md)与[插件状态用法](../../docs/plugin-development/tinybase.md)。
3. **普通 Host 文档直接使用 FS。** config、state、logging、management 通过 `FsService.documents` 保存到 `services/host/<namespace>/<key>`。文件适配提供字节限制、原子提交、按消费订阅启用的多 key 内容观察和关闭排空；各领域负责解码、验证、确认后发布及失败处理。它们不创建 TinyBase Store，也不进入 TinyBase status/recover。见 [FS 的 Host 文档契约](../FS.md#host-文档与关闭)。
4. **配置与运行策略保留各自权威。** Host 统一使用 `runtime.configRecords` 和 `runtime.state`，分别持久化 v4 原始配置记录与 v6 运行策略。声明、已保存值、显式运行时 override、schema 与 env 的职责分开；schema/env 结果和推导出的 provider 不写回。配置支持外部文件重载，state 在启动时读取。见 [Host 配置](../../docs/host/configuration.md)及 [Config](../CONFIG.md)。
5. **保存确认属于领域行为。** TinyBase mutation 先改变内存候选，`flush()` 确认完整事务的保存进度；Host 文档和插件业务按自己的保存确认规则发布状态。原子写失败保留真实错误及结果未知的可能性，不通过补偿保存或关闭时重试暗中提交候选。见 [TinyBase](../TINYBASE.md)和 [FS](../FS.md)。
6. **共享文件不引入复制协议。** 后端决定不同 Host 是否共享物理文件。FS 提供内容观察，领域 owner 验证和接纳变化；框架不选择 writer/replica，也不协调多进程写入。见 [FS 的共享文件与观察](../FS.md#共享文件与观察)。
7. **按领域语义保留其他数据。** Wretch consumer 设置与 Fonts 偏好使用 Plugin Store；凭据、二进制、源码、审计、缓存和外部后端由各领域管理。Vault 保留加密与 revision 契约；托管 SQL、原生 Drizzle 和迁移工具仍归 Services。见[逐包归属](../TINYBASE_MIGRATION.md#16-个官方插件包)、[Vault](../../docs/plugin-development/vault.md)和 [Database](../DATABASE.md)。
8. **格式转换是显式维护。** Host config v4、state v6 与 TinyBase snapshot 各自演进；运行时不保留旧字段 alias、旧格式 reader、双写或启动迁移。已有数据须按 owner 备份、离线转换并验证新 Host 恢复，失败保留原文件。见 [Host 配置](../../docs/host/configuration.md)和 [TinyBase](../TINYBASE.md)。

## 实施与验收入口

| 范围                                                  | 权威入口                                      |
| ----------------------------------------------------- | --------------------------------------------- |
| 文件目录、原子提交、观察、关闭和后端所有权            | [FS](../FS.md)                                |
| Plugin Store、快照、保存故障和恢复                    | [TinyBase](../TINYBASE.md)                    |
| 配置记录、schema、revision 与运行中应用               | [Config](../CONFIG.md)                        |
| Host runtime 输入、声明、override、reset 和持久化格式 | [Host 配置](../../docs/host/configuration.md) |
| 原生依赖接纳、子路径和生产加载                        | [版本治理](../GOVERNANCE.md)                  |
| 逐包迁移及历史验证记录                                | [迁移记录](../TINYBASE_MIGRATION.md)          |

本页不复述测试数量或把历史通过结果当成本轮验收。当前验证应覆盖实际文件格式、目录与调用方，尤其是原生 LogTape 输入、静态 node address、普通文档的多 key 订阅、关闭排空，以及无关只读挂载不阻塞可写目标。工作区测试不能替代独立安装、真实后端或在线接收方验证。

本轮边界不包含 fsync/断电保证、跨 Store 或多文件事务、多进程 writer 协调、自动接管、SQL 自动镜像，也不能证明未盘点的外部部署已完成数据转换。
