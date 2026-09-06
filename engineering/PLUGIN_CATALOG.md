# Plugin Catalog Sections

本文定义 Management Plugin catalog 的自动分区、用户布局偏好与持久化边界。catalog section 只是管理界面的布局，
不是 Plugin 能力、依赖、生命周期、route navigation 或 Workbench View/Attachment placement。

## Ownership

- `@Plugin` 不声明 UI 分区，宿主配置也不注册、命名或匹配分区。
- Management Plane 从 committed immutable catalog 的稳定事实自动派生分区；关闭 Management 时不创建布局 service 或偏好文件。
- 用户可以在当前派生分区之间移动、排序 Plugin，也可以把 Plugin 放入未分区区；不能创建、重命名或删除分区。
- section ID 由 Runtime 生成，对 client 是不透明值；client 只能原样回传，不能解析或构造。

唯一事实源是 runtime coordinator 的 committed catalog/status projection。dynamic loader 只拥有未发布 batch，布局 service
不维护第二份 catalog registry。running 状态、auto-start policy 和当前依赖选择均不决定默认分区。

catalog、偏好与布局使用 canonical definition/node address 及其 index key。读取 stopped、暂时消失或偏好中的 orphan
只能做 non-creating lookup/decode，不得 materialize Core slot、Context、effects 或 artifact lease。

Status 中的 package/source origin 同样只从 `address.definition.entry` 派生。`execution` 是正交的 route fact：它区分
`static-bundle`、`static-catalog`、`dynamic-fixed`、`dynamic-entry` 与 `unreported`，但不参与 section identity、默认分区或
canonical reference。尤其 `dynamic-entry` 可以消费 package-root identity 的 built artifact；这时 package 分区仍来自 address，
而 `entry-only` 只说明 entry 可 HMR、package 内部源码不在承诺的 source graph 中。Source/built artifact 必须来自 route 的正向
semantic fact；文件扩展名、路径或没有匹配 source fact 都不能参与 section 或 artifact 猜测。完整组合与 `recentUpdate` 语义见
[`RUNTIME.md`](RUNTIME.md#execution-provenance-与-recent-update)。

## Enabling Management

Workbench 启用时自动安装 Management Plane。无 Workbench 的宿主只能用布尔 flag 显式安装：

```ts
workbench: false,
management: true
```

`management` 不接受 object，也不承载 catalog 分类规则。这样 static 与 dynamic host 使用完全相同的 catalog 模型，新增或移除
Plugin 不要求同步修改宿主配置。

## Derived sections

Runtime 对每个 concrete Plugin definition 按以下优先级选择一个默认分区：

| 优先级 | immutable catalog fact             | `basis`            | 展示名                            |
| ------ | ---------------------------------- | ------------------ | --------------------------------- |
| 1      | concrete declaration 的 `provides` | `provider`         | 被提供 definition 的 `exportName` |
| 2      | definition entry 是 `package-root` | `package`          | 精确 package name                 |
| 3      | definition entry 是 `source-entry` | `source-directory` | 直接父目录的最后一段              |

规则是 first-match，不混合多个依据：provider role 优先于 Plugin 自己的 package/source provenance。package 分区读取
definition address 中的 package-root，不读取 execution snapshot 或 route module metadata。source 分区使用完整
`sourceSpace + direct parent path` 作为身份；`src/render/canvas.ts` 与 `src/render/fonts.ts` 同区，
`src/render/internal/debug.ts` 则属于 `src/render/internal`，不会按祖先目录、关键词或任意深度猜测合并。entry 没有父目录时，
以 `sourceSpace` 作为分区身份和展示名。

分区依据作为结构化 `basis` 暴露：`provider`、`package` 或 `source-directory`。展示名和 section ID 都由 Runtime 从该依据生成。
同一 definition 的 default node 与所有当前/未来 forks 始终属于同一个 section。只要当前 catalog 仍有至少一个 definition
派生到某个 section，该 section 就保持注册，即使用户已把其中所有 node 移走；没有 definition 派生到它时才从当前快照消失。

不根据 `requires`、`optional` 或当前 provider resolution 聚类。那些边会随 fork、override、availability 和 policy 改变，一个
consumer 也可能有多个角色；把它们用于目录布局会让默认位置随运行状态跳动，并产生不明确的主分区。依赖图仍是查看这些关系的
唯一权威视图。

每次读取使用一次 pinned coordinator projection 同时产生 status、summary 与 sections，避免先后读取导致 revision 撕裂。
派生与偏好覆盖对 catalog 和偏好各做线性索引，再执行稳定排序；不得为每个 section 重复扫描完整 catalog。

没有用户排序时，section 按 `provider → source-directory → package`、展示名、opaque ID 稳定排序；section 内按 canonical
node identity 稳定排序。用户排序以 definition family 为单位覆盖这些 fallback，不会把 forks 当成独立排序项。

## Dynamic catalog behavior

- 新 definition 在 committed catalog 出现后立即按上述规则派生；不需要同步修改宿主配置。
- definition 消失后不再出现在快照中，也不会因偏好记录而 materialize。它再次以相同 canonical address 出现时恢复偏好。
- 用户指定的目标 section 暂时消失时，placement 保持休眠，当前快照回退到该 definition 的自动分区；目标恢复后重新应用。
- 显式 `null` placement 不回退，始终表示用户选择未分区区。
- HMR batch 只有 commit 后才影响 sections；读取不会观察 unpublished draft 或半次 reconciliation。

## User preferences

Management 持久化相对于当前派生布局的覆盖，而不是分区定义：

```ts
type PluginCatalogPreferences = {
	version: 4
	placements: { definition: PluginDefinitionAddress; sectionId: string | null }[]
	sectionOrder: string[]
	definitionOrder: { sectionId: string; definitions: PluginDefinitionAddress[] }[]
}
```

- placement 缺失：跟随当前自动分区；
- placement 为 section ID：显式移动到当前存在的派生分区；
- placement 为 `null`：显式放入未分区区；
- 删除覆盖：恢复自动分区。

偏好以 definition family 为粒度，因此新 fork 自动继承相同位置和排序。暂时消失的 definition preference 可以保留，使相同
address 再次出现时恢复布局；它本身不能使 orphan 出现在 catalog 中。

layout mutation 必须拒绝未知 section、未知 node、重复 membership、重复 section 以及把同一 definition 的 forks 拆到不同
section 的输入。输入是当前 catalog 的完整目标布局，不是 patch：node 未出现在任何 section 时表示移入未分区区；省略
section 不能删除它。client 应回传所有当前 section（包括空 section）以完整表达顺序。`name` 和 `basis` 不属于 mutation，
因此不能借布局写入重命名或伪造派生依据。mutation 返回服务端重新解析后的 sections，调用方不能假设提交内容就是最终状态。

## Persistence and protocol

偏好文件使用 `management` persistence namespace 的 `plugin-catalog.json`，不进入 RuntimeState 或 Workbench backend。
reader/writer 只接受严格的 version 4 shape；没有旧版本 reader、migration 或名称/布局猜测。

Management protocol major 4 提供一个目录能力，并在每个 Plugin status 中携带严格校验的 `execution` 与 nullable
`recentUpdate`：

- `client.catalog.snapshot()`：返回同一 pinned revision 的 `plugins`、`sections` 和 `summary`；
- `client.catalog.updateLayout({ sections })`：保存 placement/order 覆盖并返回解析后的 sections。

`recentUpdate` 不改变 node membership、分区或 canonical identity。它区分成功 `applied`、旧 catalog 仍为 authority 的
`retained-previous`、新 catalog 已为 authority 的 `applied-with-issues`（`commit | lifecycle`），以及 full application reload
通过 fresh compensation host 恢复 previous definition 的 `restored-previous / application-reload`。

不存在独立 Plugin status list 与 section list 的组合读取，也不存在宿主分类配置。

## Verification

变更必须覆盖：

- Management disabled 时零布局 service/偏好写入；
- provider role、exact package、source parent-directory 的优先级与稳定身份；
- dynamic add/remove 后自动重算，stopped/auto-start-off Plugin 仍存在于 catalog；
- 用户移动、未分区、section/definition 排序和无效 mutation 拒绝；
- 新 fork 继承 family 偏好，variants 不可拆分；
- orphan preference 不 materialize node，相同 address 返回时恢复偏好；
- v4 round-trip，任何旧版本与非法 address 直接拒绝；
- protocol snapshot 的 node membership、唯一性、summary 一致性和 portable-data budgets。
- package/source label、搜索与 copy reference 只从 address 派生，execution 不改变 section identity；
- execution/recentUpdate union 严格拒绝非法组合，browser snapshot 不泄露 absolute path、module ID 或 file URL。
