# Plugin Catalog Classification

本文定义 Workbench 插件目录的分类所有权、身份、默认解析和用户偏好。这里的 group 是宿主管理界面的
catalog layout，不是插件能力、依赖、生命周期或 Workbench Extension placement。

## Ownership

- `@Plugin`、`PluginNodeInfo`、插件包 manifest 和 Workbench Contract 不声明 catalog group。
- Workbench backend 在启用时拥有分类解析与偏好持久化；Workbench disabled 时不创建分类 service、文件或 route 成本。
- 宿主只能通过顶层 `workbench.pluginGroups` 注册产品分类；插件作者不能在运行时创建、重命名或锁定分类。
- 用户可以在已注册分类之间移动和排序插件，也可以明确放回未分组区，但不能创建、重命名或删除分类。

这保持 core host-free，并避免把 UI 布局误当成插件身份。route `navigation.group`、tab group 和插件目录分类是
三个独立契约，不能共享 ID 或状态语义。

分类的唯一 Plugin 事实源是 runtime coordinator 的 committed immutable catalog/status projection。dynamic loader 只拥有当前 batch 的 unpublished
draft，Workbench 不能读取它或维护第二份 committed registry。source/package provenance 从 catalog entry 读取；running 状态不决定 classification。

catalog、偏好与布局全部以 canonical definition/node address 及其 index key 建 Map。读取 disabled、stopped、durable orphan 或 invalid address 只能做
non-creating lookup/decode，不得调用 Core intern、创建 definition/node slot、materialized record、Context、effects 或 artifact lease。Workbench registry
只为真正 running 且 mount contribution 的 owner 持有资源；catalog read model 不能借用该 registry 表示 availability。

## Host declaration

在 canonical host module 中从 `@pluxel/runtime` 导入 `pluginNodeAddressOf`，并对已 lower 的 catalog constructor 取 definition address：

```ts
workbench: {
	enabled: true,
	pluginGroups: [
		{
			id: 'observability',
			name: 'Observability',
			definitions: [pluginNodeAddressOf(OtelPlugin).definition],
			packages: ['@pluxel/otel'],
		},
	],
}
```

`id` 是稳定、不透明的偏好身份，`name` 只用于展示。宿主 ID 不得使用保留的 `package:` 前缀。
`definitions` 精确匹配结构化 Plugin definition address；default 和当前/未来 forks 继承同一分类。`packages` 的每项只能是精确 package name，或以唯一末尾 `*`
表示的 package-name prefix。除此以外不提供 glob、正则或 callback，保证 static/dynamic host 使用同一可序列化契约。

同一 definition address 只能由一个宿主分类声明。package pattern 同时命中时使用最长的 literal prefix；相同长度仍有
多个候选属于无效宿主配置，Workbench 安装必须失败并指出冲突规则。

## Automatic package groups

分类器按以下优先级为 catalog 中每个插件计算默认分类：

1. 宿主 `definitions` 的精确 definition address；
2. 宿主 `packages` 的最长 package pattern；
3. runtime source 提供可信 `packageName` 时，进入 `package:<packageName>` 自动分类；
4. 无可信包来源时进入未分组区。

自动 package group 的 ID 为 `package:` 加精确 package name，展示名就是 package name。它只由能够提供可信
`packageName` 的 runtime source 生成，插件 metadata、类名、module path 和用户输入都不能伪造 package group。普通 dynamic
file source 不推断 npm 身份；官方 package-manager 在自己的 Workbench 页面管理 package，而它发布的 Plugin 在全局目录中仍按
宿主 `definitions` 规则分类，未显式分类时进入未分组区。

## User preferences

Workbench 持久化的是相对于当前默认分类的偏好，不是分类定义：

```ts
type PluginCatalogPreferences = {
	version: 3
	assignments: { definition: PluginDefinitionAddress; groupId: string | null }[]
	groupOrder: string[]
	pluginOrder: { groupId: string; definitions: PluginDefinitionAddress[] }[]
}
```

- assignment 缺失：跟随当前宿主/package 默认分类；
- assignment 为 group ID：用户显式移动到该已注册分类；
- assignment 为 `null`：用户显式放在未分组区；
- 删除 assignment：恢复默认分类。

`groupOrder` 和 `pluginOrder` 只是已知 group/definition family 的稳定排序提示。读取时忽略未知、重复和失效项；暂时消失的
definition assignment 可以保留，以便相同 address 重新出现时恢复。一个 definition 的 variants 不能分到不同 group 或不同排序位置。
写入 API 虽接收当前 node 列表以保持 UI mutation 直接，但先折叠并验证 definition family；必须拒绝未知 group、伪造 package group、
未知 node、重复 membership 和 split-family 输入，不能把无效输入静默保存。

有效布局由一次 shared status/catalog projection 扫描和偏好覆盖得到；每次 projection 对 pinned revision 只建立一次 node/definition key 索引，分类
实现不得按插件启动状态建立第二份分组图。disabled/stopped 插件仍在 catalog 中分类，HMR 和 dynamic source add/remove 只使 catalog projection
重新计算，不参与 plugin lifecycle transaction。复杂度为 catalog/status records 加偏好 records 的线性构建与输出排序，不得为每个 group 重复全
catalog 扫描。

## Persistence

偏好使用 Workbench-owned persistence namespace，不进入 RuntimeState。这样固定 enablement 的 memory RuntimeState 与
durable Workbench 布局可以独立选择，Workbench disabled 也没有隐式状态成本。

reader/writer 只接受 version 3 definition address。其他版本、非法 address、同一 family 的冲突 assignment 或 order group
直接拒绝，不从名称或 node 布局猜测转换。

## Verification

变更必须覆盖：

- Workbench disabled 零分类 service/持久化写入；
- static definition address 规则、dynamic exact package、最长 prefix 与冲突拒绝；
- disabled/stopped catalog entry 仍分类；
- disabled/orphan read 和无效 mutation 不创建 Core slot/record 或 Workbench artifact owner；
- 用户移动、明确未分组、恢复默认、排序和无效 mutation 拒绝；
- 新 fork 继承 family 分类、同 definition variants 不可拆组；
- 新安装 package 自动出现、卸载消失、同 address 重装恢复偏好；
- 当前 v3 round-trip、family 冲突拒绝、非法 preference version 与非法 address 拒绝。
