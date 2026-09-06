# Plugin Catalog Groups

Management 拥有插件目录分组；它是管理布局，不是插件能力、生命周期、provider selection 或 Workbench placement。
用户操作和文件格式见 [`docs/workbench/plugin-groups.md`](../docs/workbench/plugin-groups.md)。

## Ownership and projection

- `@Plugin` 和 host route 不声明分类规则。static/dynamic 共用 Management service。
- Management disabled 不创建 service、不读取或写入分组文件。
- coordinator 的一次 pinned committed view 同时投影 statuses、summary 和 declaration facts；不读取 unpublished HMR draft。
- 分类以 definition family 为单位，所有 default/fork node 共用位置。读取 orphan reference 不 intern slot、不创建 Context 或资源。
- `catalog-groups.ts` 只计算布局；`PluginCatalogLayoutService` 拥有文档校验、串行读写和 persistence IO。
- section basis 只有 `dependency`、`shared`、`manual`。包名、execution、recentUpdate、running、autoStart 和实时 provider selection
  不参与自动归类。声明中的 required 包含 reachable Part requirements；optional integration 不参与分类。

## Automatic grouping

人工指定成员和显式 ungrouped 成员先从自动候选集合移除。候选 definition 的 required edge 指向存在的 concrete definition；
抽象 requirement 指向候选中声明该 `provides` 的全部实现。缺失依赖没有虚构节点，不读取当前选中的 provider。

算法先用非递归 SCC condensation 合并依赖环，再在 DAG 上从没有 consumer 的入口向依赖传播 owner。
一个 component 只存唯一入口或 shared 标记；来自同一入口的 diamond 不算共享。被不同入口到达的 component 及其下游依赖
归入共享集合，不能把这些入口合成一个业务组。环的 canonical 最小 definition reference 作为其稳定代表。

业务入口和专属依赖形成一个组，名称来自入口 displayName；共享集合名为“共享依赖”。只有至少两个 definition 的自动集合才
生成组，单个 definition（即使有多个 fork）保持平铺。空 catalog 返回空 sections；全部无关联时 UI 使用完整的“全部插件”列表。

图遍历和 owner 传播为 O(V + E)，canonical/reference 和展示排序额外需要 O(V log V)。不为每个入口分别遍历整张依赖图。
自动结果不落盘、不冻结初次发现的 catalog；新增、移除或 required declaration 更新后在下一次 snapshot 重算。

## Explicit document

唯一文件是 persistence `management` namespace 下的 `plugin-groups.json`，严格 version 1，保存可读 canonical definition references。
完整 shape、缺省行为和示例由用户文档定义。无文件与空文档等价；读取不写默认文件。旧布局文件不读取、不迁移。

人工 group 的 ID、名称、成员顺序和空组独立于当前 catalog 存活。未知但语法有效的 reference 保持休眠；definition 回归时恢复。
同一 reference 只能出现在一个 group 或 ungrouped 中；任何重复 membership、未知字段、非法 reference 或重复 ID 都拒绝。
文件最多 2,000,000 个 UTF-16 code units、1000 groups、10000 references。输出格式化为带缩进和末尾换行的 JSON。

service 每次操作读取文件文本，文本未变不重复 parse。读写在同一 host 内串行；修改校验成功才替换 active document。
磁盘文件无效时请求明确失败，不覆盖文件；修复或恢复默认后下一次请求可成功，不把失败缓存为永久 rejected ready promise。
写入使用 persistence 的 atomic put，成功后才发布新内存状态。没有额外 watcher、timer 或与 persistence 平行的文件后端。
外部文件作者应原子替换；多个进程/编辑器之间不承诺锁或 compare-and-swap，完整布局保存采用最后成功写入结果。

## Management protocol

Protocol major 6：

- `catalog.snapshot()` 返回一次 pinned catalog 的 plugins/summary 和当前解析的 sections。
- `catalog.updateLayout({ sections })` 提交完整人工布局；section 包含 `sectionId/name/nodes`，允许创建、改名和删除。
- `catalog.updateLayout({ sections: null })` 清除人工布局并重新计算自动分组。

完整布局保存会固定当前显示的组；当前未提交的 node 成为显式 ungrouped。尚未出现的新 definition 继续自动归类。
存活人工组的 orphan 成员保留；删除组同时删除该组的休眠 membership。新的自动组在首次人工保存时获得人工身份；客户端必须应用
mutation 返回的 sections，不能假设服务端 ID 与提交值一致。人工文件 key 与 wire section ID 通过可逆编码隔离；client 回传已有
opaque ID，创建组使用 `manual:` 加 UUID。分组 UI 与文件编辑共享同一份 authority。

mutation 拒绝未知 node、重复 node 和把同一 family 的 forks 分散到不同组或部分留在 ungrouped 的输入。
Persistence failure 仍报告 `persistence_failed / state: unknown`，因为自定义后端可能写入后抛错；客户端重新读取 authority。

## Verification

覆盖纯算法的空集合、无关系插件、链、diamond、共享依赖传播、多个 provider、缺失依赖、环、长链、顺序独立性；
service 的 disabled、零默认写入、文件 round-trip/live edit、reset、orphan、fork、无效输入、修复恢复、失败写入和串行修改；
Management portable validation 与 UI 分组操作、服务端 identity 接纳和无分组平铺。
