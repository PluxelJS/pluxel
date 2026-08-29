# Plugin Identity 与人类可读引用

本文定义当前 Plugin identity、source canonicalization 和人类可读投影。它是实现、持久化、日志、HTTP、Workbench、
toolchain 和 coding agent 的共同约束；作者模型见 [`PLUGIN_SYSTEM.md`](PLUGIN_SYSTEM.md)。

## 决策摘要

Pluxel 只有两个 Plugin 身份作用域：

| 作用域     | 表示什么                               | 主要事实                                                                |
| ---------- | -------------------------------------- | ----------------------------------------------------------------------- |
| definition | 一份可替换的 Plugin 实现               | canonical entry、root export、metadata/schema、source/HMR、build input  |
| node       | definition 的 default 或 fork 运行部署 | lifecycle、config value、dependency override、Context/effects、外部资源 |

每个作用域各有两种表示，不是两套身份：

- `PluginDefinitionAddress` / `PluginNodeAddress` 是严格校验、可序列化的 immutable value；
- `PluginDefinitionSlot` / `PluginNodeSlot` 是同一 address 在一个 Core registry 内 intern 后的 object-reference key。

`Address` 用于配置、持久化、RPC 和 URL codec；`Slot` 只在进程内用于 graph、DI、lifecycle 和 owner map。
同一 address 在同一 registry 内只产生一个 slot。generation 是 node 当前的一次运行，不进入 address。

fork 是同一 definition 的运行时多态，不是源码副本：default 和所有 fork 共享 constructor implementation、schema、metadata、
artifact input 与 HMR invalidation，各自隔离 auto-start/session/running 状态、config value/revision、dependency override、Context、effects 和资源 lease。

class name、constructor object、`displayName`、npm version、物理安装路径、digest 和 catalog 顺序都不参与 identity。

## 规范词汇

代码、DTO 和文档只使用以下词汇：

| 名词         | 唯一含义                              | 典型 API                            |
| ------------ | ------------------------------------- | ----------------------------------- |
| Address      | 可校验、可序列化的 definition/node 值 | `PluginNodeAddress`, `ownerAddress` |
| Slot         | address 的进程内 interned key         | `PluginNodeSlot`, `ownerSlot`       |
| Reference    | address 的稳定、可逆纯文本            | `formatPluginNodeReference()`       |
| Route        | address 的版本化 URL path 编码        | `formatPluginNodeRoute()`           |
| Label        | catalog revision 内的短展示文本       | `PluginNodeLabel`                   |
| Index key    | canonical bytes 的进程内 Map key      | `pluginNodeIndexKey()`              |
| Physical key | backend 私有的完整 SHA-256 namespace  | `pluginNodePhysicalKey()`           |

不要用 `id`、`uid`、`locator`、`slug`、`qualifiedName` 或 `friendlyName` 作为 Plugin identity 同义词。
`displayName` 是作者 metadata；`label` 是 runtime presentation。`forkId` 是稳定 identity component，不是可随意改名的标题。

## Address schema

```ts
type PluginEntryAddress =
	| Readonly<{ kind: 'package-root'; packageName: string }>
	| Readonly<{ kind: 'source-entry'; sourceSpace: string; path: string }>

type PluginDefinitionAddress = Readonly<{
	entry: PluginEntryAddress
	exportName: string
}>

type PluginNodeAddress =
	| Readonly<{ definition: PluginDefinitionAddress; variant: 'default' }>
	| Readonly<{
			definition: PluginDefinitionAddress
			variant: 'fork'
			forkId: string
	  }>
```

discriminated union 不允许 default node 携带 `forkId`，也不允许 fork 缺少 `forkId`。外部 `unknown` 必须在 trust boundary
通过 `parsePlugin*Address()`；内部纯 helper 接受已校验 address，不在每次 `Map.get()` 前重复 parse。

identity 的唯一性域是一个 host application/persistence profile，不是全球：

- 一个 catalog 中同一 `packageName` 只能对应一个 resolved physical package source；
- 一个 source space 中 canonical POSIX `path` 唯一；
- 一个 definition 中 `forkId` 唯一；
- 跨 deployment 的相同 address 由 carrier 的 deployment/root/boot facts 区分。

## Entry canonicalization

### Package root

package definition 使用 canonical npm package name + package root named export。只有 package root `"."` 可以承载 Plugin。
workspace symlink、store path、版本、subpath 和构建产物路径不进入 address。可信 package plan 必须优先于 source-space
classification；同一 constructor 的多个 root 名称、plugin-bearing subpath 和跨包 Plugin re-export 均 fail-fast。

### Source space

`sourceSpace` 是 host/source provider 拥有的稳定逻辑名称，物理 root 不进入 address。内建 `app` 映射 host source root；
外部 source 使用显式命名 mapping。name 使用 `[A-Za-z0-9][A-Za-z0-9._-]*`，在一个 host persistence profile 内唯一且不可变。

生产 semantic pass 按固定顺序生成 source entry：

1. 由 bundler resolver 得到 filesystem module path，按 bundler grammar 去掉 query/hash；
2. 先应用可信 package plan，命中 package root 后停止 source classification；
3. 对 source-space roots 和 existing file 使用 native `realpath()`；
4. 选择包含该 file 的最具体 root，用 native `path.relative()` 验证 containment；
5. containment 成功后才转换为 `/` 分隔的 POSIX relative `path`；
6. 拒绝空路径、absolute、跨 drive/share、`..`、反斜杠、NUL、query/hash 和 symlink escape。

root 内 symlink 指向 root 外时拒绝；symlinked root 本身可以使用，identity 仍保留 logical source-space name。Linux 不 lowercase，
Core 不擅自做 Unicode normalization。纯 AST diagnostics 可以生成 lexical test address，但不是 runtime/build identity producer。

修改 source-space name、映射或嵌套关系会改变 address，属于 identity-breaking host 配置变更。需要跨布局稳定性的 Plugin 应从 package root 暴露。

## Canonical codec

`@pluxel/core` 的 browser-safe identity module 是 parse、equality、ordering、canonical bytes、index key、reference 和 route 的唯一实现。
runtime、logger 和 Workbench 不包裹平行 codec。

canonical bytes 使用 codec version、kind tag、字段长度和 UTF-8 字段，编码是 injective 的，不依赖 JSON property order 或 delimiter。
`plugin*IndexKey()` 是 bytes 的 hex 文本，只用于进程内 map/order；不能写成 durable owner ID。持久 document 保存 structured address；
需要可解析文本列时保存 canonical reference；filesystem/backend namespace 使用 canonical bytes 的完整 SHA-256，并在需要时保存 exact owner envelope。

### Plugin node reference

reference 用于 CLI 精确输入、日志详情和诊断，稳定、可逆且不依赖 catalog：

```text
package:@acme/orders::OrdersPlugin
package:@acme/orders::OrdersPlugin#fork=east
source:app/plugins/orders.ts::OrdersPlugin
source:managed/orders.mjs::OrdersPlugin#fork=tenant-a
```

每个逻辑 segment 独立 percent-encode；parser 拒绝 encoded slash/backslash、非 canonical percent encoding、控制字符、
未知前缀、字段缺失和超限输入。reference 不是另一个 branded ID，也不代替普通 structured persistence。

### Plugin node route

route 用于 Workbench navigation、management catalog projection 和 logger category 等 host-owned addressing，
稳定、可逆、带 codec version且不依赖 catalog。它不是业务 HTTP namespace；Plugin 的 Elysia path 不从 node route 派生：

```text
/plugins/v1/package/OrdersPlugin/@acme/orders
/plugins/v1/fork/east/package/OrdersPlugin/@acme/orders
/plugins/v1/source/OrdersPlugin/app/2/plugins/orders.ts
/plugins/v1/fork/tenant-a/source/OrdersPlugin/managed/1/orders.mjs
```

`formatPluginNodeRoute()` 返回无 leading slash 的相对 route。source path 前的十进制数是 path segment count；
`parsePluginNodeRoute()` 返回 address 和 `consumedSegments`，因此 View/HTTP suffix 不需要 magic delimiter。parser 限制总 segment、
字段和 decoded byte 长度，并拒绝 dot segment、encoded separator、重复/非 canonical encoding。正常 lookup parse 后使用 index Map，
不按 label 扫描 catalog。

### Plugin node label

label 只用于 Workbench 和 pretty log。runtime 先使用 `displayName`，fork 追加 ` / <forkId>`；发生冲突时依次追加 package/source
provenance、root export，最终可回退完整 reference。相同 address 重复出现直接报错。新增同名 Plugin 可以改变必要的 label qualification，
但不能改变 address、reference、route、React key、policy 或持久状态。

## 各领域作用域

| 领域               | definition scope                               | node scope                                     | 领域私有 identity                  |
| ------------------ | ---------------------------------------------- | ---------------------------------------------- | ---------------------------------- |
| Core graph/DI      | required/optional edge target                  | slot、lifecycle owner                          | generation                         |
| HMR                | source/module invalidation，一次枚举全部 nodes | 每个 node 重建并保留 address/slot              | module revision                    |
| Config             | schema、defaults、declaration path             | value、revision、update notification           | config record revision             |
| RuntimeState       | fork family、required token                    | auto-start、provider target、consumer override | file revision                      |
| Logging            | 无 policy owner                                | category、filter、policy、reference/label      | rootId、bootId、stream epoch/seq   |
| Management catalog | host classification、user ordering/assignment  | displayed variants、target grouping            | group id、preference revision      |
| HTTP               | 无                                             | final Elysia path 的 contribution owner        | sealed application generation      |
| Artifact           | declaration/source/build input，不含 forkId    | node-to-artifact binding                       | fingerprint、publication revision  |
| Database           | schema/migration declaration                   | data owner                                     | physical schema/role/instance      |
| Vault              | 无                                             | default namespace owner                        | explicit shared namespace、blob id |
| Cache/Rates        | 无                                             | caller namespace owner                         | canonical key、TTL state           |
| Wretch settings    | 无                                             | consumer settings owner                        | settings revision/file key         |

HMR 对一个 definition 的 default/forks 生成一次 commit plan，不能让部分 fork 使用新源码、部分 fork 使用旧源码。
artifact build cache 不含 `forkId`，相同输入只编译一次；node binding 和 generation lease 仍各自隔离。

config patch 顺序是 validate -> 保存 desired record -> 通知 addressed running generation -> 报告 apply 结果。listener 缺失或失败返回
`saved-not-applied`，desired config 保留供后续 mutation、显式 restart 或下次 boot 重试。修改一个 fork 不通知 sibling/default。

Management 分类偏好按 definition family 保存，新 fork 自动继承；一个 definition 的 variants 不能被分到不同组。Workbench extension/resource owner
仍按 node，grant 按 generation。Plugin 在 `ctx.elysia` 中声明的 path 就是最终产品 path；Runtime 不从 node identity 派生隐藏 namespace，
也不提供另一份 `publicPath` 映射。多个 node 需要同时暴露 HTTP 时，业务 config 或唯一 gateway 必须让最终 path 保持不冲突。

## 持久化版本

每个边界只读取和写入当前 schema。版本不匹配、address 非法或 owner envelope 不一致时 fail-fast；浏览器本地 UI 状态则丢弃
无效 snapshot 并恢复默认值。实现不提供双读、自动转换、URL redirect、physical namespace 领养或 display-name fallback。

| 领域                          | 当前版本/编码                | 当前 owner 契约                     |
| ----------------------------- | ---------------------------- | ----------------------------------- |
| RuntimeState                  | v5                           | structured definition/node address  |
| Config file/env               | v3                           | structured node address             |
| Logger policy                 | v3                           | structured node address             |
| Management catalog preference | v3                           | structured definition address       |
| Workbench browser state       | v4                           | current versioned Plugin route      |
| Database owner registry       | node reference               | exact current node reference        |
| Vault                         | full canonical SHA-256       | exact current node address bytes    |
| Wretch settings               | `consumers/v3` + envelope v2 | exact current node address envelope |
| Cache/Rates                   | v3 canonical-byte namespace  | exact current node address bytes    |

不能从 display name、class name、catalog 顺序、物理路径或 opaque catalog key 猜测 identity。需要保留数据的部署必须在升级前由
宿主拥有的显式离线工具转换；runtime 正常启动路径始终只有一个当前契约。

## 性能与安全

- slot/index lookup 为 O(1)；一次 node intern 只校验一次完整 address，registry 拒绝 foreign slot；definition HMR 枚举为
  O(k)，k 是该 definition 当前 node 数；
- catalog 每个 revision 用 O(N) 建立 address/reference/route/label projection，后续按 index/route O(1) lookup；
- route/reference 按输入长度单次线性 parse；filesystem `realpath` 只在 build/discovery/HMR boundary，并缓存 root/file 结果；
- logger category 首次出现时严格解析，immutable category/address 使用 `WeakMap` 缓存且在 policy mutation 后失效；稳定日志流只做
  identity/rank lookup 和数值比较，不做 filesystem I/O、catalog scan 或 SHA-256；
- Config 内存 owner lookup O(1)，200 ms 合并后原子重写 snapshot 是 O(B)，B 为全部 serialized config bytes；当前不宣称无界 fork/config 规模；
- physical namespace 使用完整 SHA-256，不使用无 collision record 的截断 digest；
- route、reference、CLI、JSON 和 persistence 输入均有长度、字符与结构校验；source route 不泄漏机器绝对路径；
- label/displayName/forkId 输出转义控制字符，不能伪造日志结构或参与授权。

如果 Config snapshot 的 record/byte/mutation 预算成为实测瓶颈，应在 Config backend 内改用 shard、journal 或 transactional KV；
不能通过改变 node identity、暴露 digest ID 或复制 per-fork schema 来规避存储问题。

## 实现入口与验证

- Core address/slot/codec：`packages/core/src/plugins/runtime/identity.ts`
- Core logger category codec：`packages/core/src/logger/categories.ts`
- source canonicalization：`packages/rolldown/src/rolldown/plugins/pluginSemanticsPlugin.ts`
- catalog projection/label：`packages/runtime/src/api/features/plugins/catalog-projection.ts`、`packages/runtime/src/runtime/plugin-label.ts`
- Workbench route/browser state：`packages/workbench-app/src/workbench/paths.ts`、`packages/workbench-app/src/app/workbench/state.ts`
- RuntimeState/Config/logger/catalog persistence：对应 `packages/runtime/src/services/` 与 `packages/runtime/src/logger/`

变更 identity 时至少验证 package/source、default/fork、reference/route round-trip、encoded separator 拒绝、native realpath containment、
definition-wide HMR、fork config isolation、definition-family classification、logger structured owner、HTTP readable route 和全部当前版本 reader。
仓库中不得重新出现 JSON-in-path、catalog-dependent Plugin ID、opaque digest public ID 或第二套 address equality/key codec。
