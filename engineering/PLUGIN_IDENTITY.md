# Plugin Identity 与人类可读引用

Plugin identity 贯穿 graph、配置、持久化、日志、管理面和工具链。本页拥有 address、canonicalization 和 codec；作者模型见 [Plugin 系统](PLUGIN_SYSTEM.md)。

## 决策摘要

| 作用域     | 身份                                | 独立内容                                                    |
| ---------- | ----------------------------------- | ----------------------------------------------------------- |
| definition | canonical entry + root named export | implementation、schema/metadata、source/HMR、artifact input |
| node       | definition + default/fork           | config/revision、依赖选择、运行意图、generation/resources   |

Address 是可校验、可序列化的 immutable value；Slot 是一个 Core registry 对同一 address intern 得到的 object key。同 registry、同 address 只有一个 Slot。generation 表示 node 的一次运行，不进入 address。

lowered class 的 `address()` 支持 concrete/abstract Plugin；`nodeAddress(forkId?)` 只支持 concrete Plugin。`PluginInstanceNodeAddress<S, A>` 保留 default/fork 判别和实例类型。生成控制入口还关联配置 input/output，SDK 统一 `sdk.plugin(nodeAddress)`。这些投影不创建实例，也不从父 class 继承 lowering facts。

fork 共享 implementation、schema、metadata、编译输入和 HMR，独立持有运行状态、config、override、Context、effects 和 lease。class name、constructor object、displayName、npm version、安装路径、digest、catalog 顺序均不参与身份。

## 规范词汇

| 名称         | 含义                           | API 示例                        |
| ------------ | ------------------------------ | ------------------------------- |
| Address      | 可序列化 definition/node 值    | PluginNodeAddress、ownerAddress |
| Slot         | registry 内 object key         | PluginNodeSlot、ownerSlot       |
| Reference    | 稳定可逆文本                   | formatPluginNodeReference()     |
| Route        | 版本化 URL path                | formatPluginNodeRoute()         |
| Label        | catalog revision 内的展示文本  | PluginNodeLabel                 |
| Index key    | canonical bytes 的内存 Map key | pluginNodeIndexKey()            |
| Physical key | backend 私有 SHA-256 namespace | pluginNodePhysicalKey()         |

identity 字段使用这些具体名称。displayName 属于作者 metadata，label 属于展示，forkId 是稳定身份分量。

## Address schema

```ts
type PluginEntryAddress =
	| Readonly<{ kind: 'package-root'; packageName: string }>
	| Readonly<{ kind: 'package-subpath'; packageName: string; subpath: string }>
	| Readonly<{ kind: 'source-entry'; sourceSpace: string; path: string }>

type PluginDefinitionAddress = Readonly<{
	entry: PluginEntryAddress
	exportName: string
}>

type PluginDefaultNodeAddress = Readonly<{
	definition: PluginDefinitionAddress
	variant: 'default'
}>

type PluginForkNodeAddress = Readonly<{
	definition: PluginDefinitionAddress
	variant: 'fork'
	forkId: string
}>

type PluginNodeAddress = PluginDefaultNodeAddress | PluginForkNodeAddress
```

default 禁止 forkId，fork 必须有 forkId。外部 unknown 在边界使用 parsePlugin*Address，内部 helper 接受已校验值。

唯一性范围是一个 application/persistence profile：packageName 对应一个物理来源，sourceSpace 内 canonical path 唯一，definition 内 forkId 唯一。跨 deployment 同址对象由 carrier 的 deployment/root/boot facts 区分。

### 调用证据与可序列化身份

地址工厂把调用证据绑定到确切 immutable object：Core class 证据保存 constructor，Host 控制入口证据保存声明摘要。Core browser-safe `internal/plugin-address-evidence` 用私有 WeakMap，不依赖 Host。class default address 按 constructor 缓存，fork address 每次创建；生成 factory 的独立值互不覆盖证据。

证据不改变字符串身份字段。可枚举 symbol 只带冻结标记，equality/index/reference/route/JSON 只用 address 字段。SDK 规范化前读证据，在 committed lookup 或配置事务中再验证当前 implementation/摘要。reference.address 保留原对象；动态输入则捕获 immutable 身份快照。HMR 后旧 class 地址仍要求旧 constructor。

JSON 往返或显式 parse 得到普通动态地址，可用于配置/lifecycle；业务 instance 访问必须来自 class 或生成控制入口。类型断言不能恢复证据。spread/Object.assign 只复制标记，不复制 WeakMap 注册，选择时拒绝分离证据；不同 Core 副本的 foreign evidence 同样拒绝。

class 地址保留 instance 类型，但 config 为动态未知字段；完整配置类型由[生成控制入口](../docs/development/plugin-control.md)提供。Script JSON 可编码原厂地址为纯身份，规则与预算见 [Agent Workflow](AGENT_WORKFLOW.md)。

## Entry canonicalization

### Package entry

package definition 使用 canonical npm name、显式 export path 和 named export。root 为 package-root，子路径为 package-subpath，例如 `{ kind: 'package-subpath', packageName: '@pluxel/services', subpath: './plugins' }`。subpath 必须为规范非空 ./ 路径，拒绝 traversal、query/hash、通配符；更改公开路径会改变 identity。

可信 package plan 优先于 source classification。一个 constructor 只允许一个权威 named export；多入口/多名称导出和跨包 re-export 拒绝。一个 /plugins 入口可包含多个不同 Plugin。symlink/store/version/build path 不进入 address。

### Source space

sourceSpace 是 provider 拥有的稳定逻辑名称，内建 app 对应 Host source root，外部 root 显式命名。名称匹配 `[A-Za-z0-9][A-Za-z0-9._-]*`，profile 内唯一。

production semantic pass 按以下顺序生成 source address：

1. bundler resolver 取得路径，按其 grammar 去 query/hash。
2. 优先应用可信 package plan。
3. 对 source roots/existing file 执行 native realpath。
4. 选择最具体 containing root，用 native path.relative 校验 containment。
5. 转换为 POSIX relative path，拒绝空/absolute/跨 drive 或 share、..、反斜杠、NUL、query/hash 和 symlink escape。

symlink root 合法，root 内指向外部的文件拒绝。Linux 不 lowercase，Core 不做 Unicode normalization。AST-only diagnostics 的 lexical test address 不作为 runtime/build 身份。更改 space 名称、映射或嵌套关系属于 identity-breaking 配置；跨布局稳定 Plugin 使用 package entry。

## Canonical codec

Core browser-safe identity module 唯一实现 parse、equality、ordering、bytes、index、reference、route。canonical bytes 以 version/kind/字段长度/UTF-8 编码，独立于 JSON 属性顺序和 delimiter。

Index key 为 bytes 的 hex，仅用于内存。持久文档保存 structured address，可解析文本列使用 reference，backend namespace 使用完整 SHA-256，必要时附 exact owner envelope。

### Plugin node reference

reference 用于 CLI 精确输入和日志诊断，不依赖 catalog：

```text
package:@acme/orders::OrdersPlugin
package:@acme/orders::OrdersPlugin#fork=east
source:app/plugins/orders.ts::OrdersPlugin
source:managed/orders.mjs::OrdersPlugin#fork=tenant-a
```

逻辑 segment 独立 percent-encode。parser 拒绝 encoded slash/backslash、非 canonical encoding、控制字符、未知前缀、缺字段、超限值。

### Plugin node route

route 为 Workbench、Management、logger 提供 host-owned address；业务 Elysia path 自行声明：

```text
/plugins/v1/package/OrdersPlugin/@acme/orders
/plugins/v1/fork/east/package/OrdersPlugin/@acme/orders
/plugins/v1/source/OrdersPlugin/app/2/plugins/orders.ts
/plugins/v1/fork/tenant-a/source/OrdersPlugin/managed/1/orders.mjs
```

formatPluginNodeRoute 返回无 leading slash 路径；source 的十进制数为 path segment count。parse 返回 address/consumedSegments，后续 suffix 可继续解析。总 segments、字段、decoded bytes 有界，拒绝 dot segment、encoded separator、重复/非 canonical encoding。解析后按 index 查表。

### Plugin node label

buildPluginNodeLabels/formatPluginNodeStandaloneLabel 是 catalog/日志共用的纯展示函数。displayName 优先，fork 追加 ` / <forkId>`；冲突依次追加 provenance、root export，必要时完整 reference。同址重复输入报错。新增同名 Plugin 可改变 label，但不会改变 address/route、React key、policy 或持久状态。

## 各领域作用域

| 领域        | definition                       | node / 其他寿命                                 |
| ----------- | -------------------------------- | ----------------------------------------------- |
| Core/DI     | required/optional target         | node slot；generation Context/effects           |
| HMR         | 一次 invalidation 枚举全部 nodes | 每 node 重建、保留 address/slot                 |
| Config      | schema/default/declaration path  | input/output、revision、listener                |
| HostState   | fork family、required token      | auto-start、provider、consumer override         |
| Logging     | —                                | node policy/category；rootId/bootId/epoch       |
| Management  | family 分类/排序                 | variants/target；preference revision            |
| HTTP        | —                                | 最终 route contribution；application generation |
| Artifact    | declaration/source/build input   | node binding；publication/fingerprint           |
| Database    | schema/migration                 | node owner；schema/role/instance                |
| Vault       | —                                | node 默认 namespace；命名 namespace/blob        |
| Cache/Rates | —                                | caller namespace；key/TTL                       |
| Wretch      | —                                | consumer settings；provider Store rows          |

同一 definition 的 default/forks 使用一次 HMR plan；artifact cache 不含 forkId，node binding/lease 仍隔离。config 的 node 隔离和保存/通知顺序见 [Config](CONFIG.md#保存与应用)。

Management 分类按 definition family，新 fork 继承，variants 不拆组。Workbench descriptor 按 definition，publication owner 按 node，opened target 按 generation/socket epoch。最终 Elysia path 由业务声明，多 node 由业务配置或 gateway 避免冲突。

## 持久化版本

各 owner 只读写当前格式，address/owner envelope 不匹配时拒绝；浏览器 UI 可丢弃坏 snapshot 恢复默认。数据升级由显式工具转换，运行时不猜 identity。

| 领域                  | 当前格式                                                    | owner                        |
| --------------------- | ----------------------------------------------------------- | ---------------------------- |
| HostState             | v7                                                          | structured definition/node   |
| Config document       | v4                                                          | structured node              |
| Logger policy         | v3                                                          | structured node              |
| Management groups     | v1                                                          | structured definition        |
| Workbench workspace   | [原生 Worksplit snapshot](FRONTEND.md#原生工作区与文档路由) | 当前版本 Plugin route/target |
| Database registry     | node reference                                              | exact reference              |
| Vault                 | 完整 canonical SHA-256                                      | exact node bytes             |
| TinyBase snapshot     | pluxel.tinybase / formatVersion 1                           | exact node envelope          |
| Wretch settings       | consumerSettings row v1，托管 TinyBase                      | exact consumer address       |
| Cache/Rates namespace | v3 canonical-byte namespace                                 | exact node bytes             |

格式/路径的具体 producer 和 parser 由各领域维护。保存数据的部署在升级前备份并离线转换。

## 性能与安全

slot/index lookup 为 O(1)，intern 时完整校验一次并拒绝 foreign slot；definition HMR 为 O(k)。catalog projection 每 revision O(N)，route/reference 线性解析，realpath 仅在 build/discovery/HMR 执行并缓存。

日志 category/address 以 WeakMap 复用，policy mutation 失效；热流只查 identity/rank。Config 每次 mutation 等待原子完整 snapshot 确认，成本 O(B)，详见 [Config](CONFIG.md#输入接纳与成本)。

physical namespace 使用完整 SHA-256。route/reference/CLI/JSON/persistence 均校验长度、字符、结构；source route 不泄露绝对路径。label/displayName/forkId 转义控制字符，展示字段不参与授权。存储规模问题在 backend 解决，不改变 node identity 或复制 per-fork schema。

## 实现入口与验证

- Core `plugins/runtime/identity.ts`：address/slot/codec；`internal/plugin-address-evidence.ts`、runtime definition：调用证据。
- Core `logger/categories.ts`、`plugins/runtime/plugin-label.ts`：日志和展示。
- Rolldown `rolldown/plugins/pluginSemanticsPlugin.ts`：canonicalization。
- Services `management/api/features/plugins/catalog-projection.ts`：catalog。
- Workbench `shell/src/workbench/paths.ts`、`app/workbench/session.tsx`：route/target；[Frontend](FRONTEND.md#原生工作区与文档路由)。

回归覆盖 package/source、default/fork、codec round-trip/非法编码、realpath containment、definition-wide HMR、config fork 隔离、family 分类、structured logger owner、HTTP route 和当前格式 reader。变更使用点继续复用本 codec。
