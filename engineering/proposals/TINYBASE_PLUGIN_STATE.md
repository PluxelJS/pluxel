# TinyBase 状态重构决策与验收索引

状态：Core 内建 FS/TinyBase 与 Host saved-layer 跨实例同步已实施；实际验证和剩余边界见[迁移记录](../TINYBASE_MIGRATION.md)。更新：2026-11-02。初次状态重构的源码基线：Pluxel `67f2082e`；本轮内建调整基于 `7b9b544d`。

本页只保留必要决策与未验证边界。当前契约由 [FS](../FS.md)、[TinyBase](../TINYBASE.md)、[Config](../CONFIG.md) 和 [Database](../DATABASE.md)维护；公开写法见[插件状态用法](../../docs/plugin-development/tinybase.md)。逐包数据归属、实现覆盖与实际验证见[迁移记录](../TINYBASE_MIGRATION.md)。实施前的讨论和拟议 API 留在 Git 历史。

## 已实施版本的决策

本节记录当前实现。FS 与 TinyBase 已从可选 Service 改为 Core 固定能力；原生 Store、领域权威和保存确认语义保持原契约。

1. **统一保存底层，保留领域权威。** 官方插件的配置 saved layer、普通偏好和有界结构化状态使用 Host 托管的 TinyBase。部署配置仍通过 `configs.use()`，Core records/revision、完整 Valibot 校验、配置优先级与 validate → save → apply 不变，不要求纯配置插件再打开 Store。
2. **使用原生 Store。** 每个 Plugin node（含 fork）只有一份托管 Store，Part 共享所属 Plugin 的实例。作者直接使用 `tinybase` 及上游子路径，内建能力仅提供 `open(store?)`、`flush()` 等宿主接入契约，不引入 CRUD、schema 或事务包装。
3. **持久化由宿主管理。** Core 提供固定 FS/TinyBase、owner 隔离与关闭排空，应用通过 `config.storage` 选择一次后端，省略时使用 InMemory。Host 默认接入私有 config/state 文档，Plugin 不声明持久策略、不管理 Persister；Vault 保留自己的加密与 revision 契约。
4. **内存变化与保存确认分开。** 原生 mutation 同步更新内存，`flush()` 等待完整事务的保存进度。Wretch、Fonts 与 Host 文档继续在保存确认后发布领域状态，保存失败不会伪装成成功，也不通过补偿保存或关闭时重试悄悄提交候选。
5. **复用版本接纳与绑定。** TinyBase 与 Cap’n Web 共用内部版本事实和安装校验机制；TinyBase 的精确 runtime 依赖归 Core，Cap’n Web 仍归 Workbench。直接使用上游并与托管 Store 互操作的消费者声明对应 peer/dev；开发、静态构建和生产加载先校验再绑定原生模块。私有 TinyBase 保持原解析，不通过全局 override 或框架镜像入口统一。
6. **保留托管 SQL。** Database、PGlite/PostgreSQL 后端和 owner 生命周期继续归 `@pluxel/services/database`；Rolldown、Vite 与 CLI 保留 artifact 和迁移工具。查询与 schema 使用原生 Drizzle，不新增数据库发布包，Database 不加入默认服务组合。应用仍可自管 SQL 连接。
7. **按领域语义迁移。** 普通设置进入 TinyBase；凭据、二进制、文档源码、审计事件、缓存/限流算法与外部后端仍由原领域管理，不为了统一存储而削弱资源、事务或安全保证。
8. **转换必须显式。** TinyBase 包版本、Host 快照格式与插件业务结构分别演进；旧数据先备份、离线转换并校验重开。运行时不保留旧 JSON reader、双写或启动迁移，不用默认值覆盖损坏或未知格式。

## 已实施的覆盖

| 范围               | 实施结果与权威入口                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全部 16 个官方插件 | 已逐包盘点；统一配置底层，Wretch 和 Fonts 的额外偏好迁入原生 Store，其余数据按真实领域职责保留。见[逐包清单](../TINYBASE_MIGRATION.md#16-个官方插件包)。  |
| Host 与 Services   | 配置、运行策略、Logging policy、Management 布局使用 Host 私有文档；保存确认、并发、故障与撤回由 [TinyBase](../TINYBASE.md)维护。                          |
| 模板与演示应用     | Todo 与 Bot source 状态迁入原生表；应用依赖、共享 peer/dev、测试服务与生成项目 AGENTS 同步。见[模板与应用](../TINYBASE_MIGRATION.md#services模板与应用)。 |
| 构建与发行         | 原生子路径、同版多安装路径、共享异版拒绝、私有异版隔离与工作区外安装均有回归。见[版本治理](../GOVERNANCE.md)及[验证记录](../TINYBASE_MIGRATION.md)。      |
| SQL 服务           | 原 Services 入口、原生 Drizzle、迁移 CLI、开发转换和生命周期保留；本次未删除或转换 SQL 数据。见[SQL 验证](../TINYBASE_MIGRATION.md)。                     |

公开用法、工程边界、包导出、真实调用方、模板与 Tegami 已同步。目标回归、独立安装、生成项目 smoke 和文档生产构建的实际结果统一维护在迁移记录，不在本页重复测试计数或 API 示例。

## 剩余验收边界

- **外部旧数据转换。** 已核对的本地数据根没有待转换的旧设置，不能据此声称外部部署已经转换。外部数据仍需按 owner 备份、转换与恢复验收，见[本地盘点](../TINYBASE_MIGRATION.md)。
- **跨格式升级与降级。** 本次首次引入 `pluxel.tinybase` format 1；同格式恢复及未知格式拒绝已验证，没有前代真实快照可用于跨格式转换和匹配备份恢复。
- **在线与真实后端。** 未执行的 live HMR、真实 PostgreSQL 和依赖浏览器服务的交互验收由[迁移记录](../TINYBASE_MIGRATION.md)明确列出；隔离测试和文档示例编译不能替代这些证据。
- **独立消费者的上游声明。** 较大 Services installed suite 的运行阶段通过，严格声明检查仍被 Elysia/TypeBox 的上游类型错误阻断；没有增加白名单或放宽 `skipLibCheck`，最小复现与版本见[独立安装记录](../TINYBASE_MIGRATION.md)。

当前业务 Store 仍是一份 Host 内的单 writer 有界快照；配置复制采用部署固定的唯一写入节点。范围不包含 fsync/断电保证、跨 Store 事务、多进程共享物理 writer、离线管理写入、自动接管或 SQL 自动镜像。
