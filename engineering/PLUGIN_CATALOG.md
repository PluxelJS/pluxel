# Plugin Catalog Groups

Management 将 committed Plugin declarations 投影为目录分组。插件管理编辑这份布局，应用目录消费同一份分组。运行图与 Workbench placement 由各自的声明和运行契约决定。用户操作与文件格式见[插件分组](../docs/workbench/plugin-groups.md)。

## Ownership and projection

一次 pinned committed view 同时提供 plugins、summary 和 declarations。Native/Vite 共用 Management service；disabled 时不创建 service 或读写文档。

分组以 definition family 为单位，default/fork nodes 共用位置，orphan reference 读取不创建 slot/Context。`catalog-groups.ts` 负责纯布局算法，`PluginCatalogLayoutService` 负责文档验证和串行 IO。

Section basis 只有 `dependency`、`shared`、`manual`。自动分类只使用声明的 required edges，包括 reachable Part requirements；optional integration、实时 provider selection、包名和运行状态不参与。

## Automatic grouping

人工 group 和显式 ungrouped 成员先移出候选。Required edge 指向已存在 concrete definition，抽象 requirement 指向候选中全部 `provides` 实现，缺失依赖不产生虚构节点。

算法用非递归 SCC condensation 合并环，再从 DAG 中没有 consumer 的入口向依赖传播 owner。Component 只记录唯一入口或 shared：同一入口的 diamond 保持专属，不同入口共同到达的 component 及其下游归共享集合，入口本身保持独立。环以 canonical 最小 definition reference 为稳定代表。

入口和专属依赖形成以入口 displayName 命名的组，共享集合名为“共享依赖”。至少两个 definitions 才成组，多个 forks 仍只算一个 definition。空 catalog 返回空 sections，无关联时 UI 展示完整“全部插件”。

遍历与传播为 O(V + E)，reference/展示排序另需 O(V log V)。结果按每次 snapshot 的当前 catalog 重算，无需持久化或逐入口重复遍历。

## Explicit document

`requireHostDocuments(root, 'management')` 提供唯一 `plugin-groups.json`，借用 Core FS backing，经 Host document storage 提交。严格 version 1 保存 canonical definition references。无文件与空文档等价，读取不写默认文件。

人工 ID、名称、顺序和空组独立于 catalog 存活。未知但有效的 reference 保持休眠，definition 回归时恢复。重复 membership/ID、未知字段和非法 reference 均拒绝。限额为 2,000,000 UTF-16 code units、1000 groups、10000 references；输出带缩进和末尾换行。

Service 在同一 Host 内串行读取和修改，文本未变不重新 parse。`put(key, text)` 通过 [TinyBase](TINYBASE.md) 的 candidate/confirm 提交，成功才替换 active document。无效磁盘文件保留并明确报错，修复后下次请求可恢复。外部编辑应原子替换；跨进程完整保存采用最后成功写入结果。

## Management protocol

Wire 版本由 [`RUNTIME_MANAGEMENT_PROTOCOL_MAJOR`](../packages/services/src/management/web/protocol.ts) 定义。分组接口为：

- `catalog.snapshot()`：返回同一次 pinned catalog 的 plugins/summary 和当前 sections。
- `catalog.updateLayout({ sections })`：提交完整人工布局，每项包含 `sectionId/name/nodes`。
- `catalog.updateLayout({ sections: null })`：清除人工布局，恢复自动分组。

完整保存固定当前显示组，未提交的当前 node 成为显式 ungrouped，未来出现的 definition 继续自动分类。存活人工组保留 orphan，删除组删除其休眠 membership。自动组首次保存后取得人工身份，客户端使用 mutation 返回的 sections。

文件 key 与 wire section ID 通过可逆编码隔离，客户端回传已有 opaque ID，创建组使用 `manual:` + UUID。Mutation 拒绝未知/重复 node、将 family 的 forks 分散到不同组或部分留在 ungrouped 的输入。

提交失败返回 `persistence_failed / state: unknown`。写入可能已发生，客户端重新读取 authority 决定最终状态。UI 和文件编辑共用同一份文档。

## 实现入口

- `packages/services/src/management/services/management/PluginCatalogLayoutService.ts`：文档、串行 IO 与失败恢复。
- 同目录 `catalog-groups.ts`：family 投影和自动分组。
- `packages/services/tests/management/plugin-catalog-layout.test.ts`：存储、修改与恢复。
- `packages/services/tests/management/catalog-navigation.test.ts` 验证目录读取、分组编辑和节点标题更新。`management/catalog-labels.test.ts` 验证提交后目录的标签与重名区分。

## Verification

算法覆盖空集合、无关系、链、diamond、共享传播、多 provider、缺失依赖、环、长链和顺序独立性。Service 覆盖 disabled、零默认写入、round-trip/live edit、reset、orphan/fork、坏文件修复、写入失败与串行修改。Management/UI 覆盖 portable validation、服务端 identity 接纳、分组操作与平铺。
