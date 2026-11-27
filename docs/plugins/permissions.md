---
title: 权限管理
description: 用类型化范围、角色等级和临时授权裁决插件动作。
---

`@pluxel/plugin-permissions` 是工作区预览。应用为主体提供非空字符串 `subjectKey`，并从可信事件构造作用域上下文。业务插件声明动作，Permissions 保存授权、成员绑定和角色。

## 装配和声明

将 `Permissions` 加入应用的固定插件，安装 [Sqlite 服务](../host/services.md)，并启动需要检查权限的插件。独立的策略域用多个 `Permissions` fork 装配。使用新的预览 SQLite 存储启动 v2。

Cloudflare Workers 使用 `2026-11-17` 或更新的兼容日期。使用较早日期时启用 `new_module_registry`，为固定 Workbench 声明提供 `import.meta.url`。发布前为该节点的 D1 绑定应用初始迁移。 [Cloudflare 模块加载](https://developers.cloudflare.com/workers/wrangler/bundling/#runtime-module-loading) · [Pluxel SQLite 和 D1](../host/services.md)

业务插件在 `init` 声明动作。相同名称的动作按声明插件的定义隔离，句柄属于获取它的调用方和节点代际。动作撤回后句柄失效。

```ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { Permissions, type PermissionHandle } from '@pluxel/plugin-permissions'

@Plugin()
export class Reports extends BasePlugin {
	private exportReport!: PermissionHandle

	constructor(private readonly permissions: Permissions) {
		super()
	}

	protected override init() {
		this.exportReport = this.permissions.declare({ action: 'report.export' })
	}

	canExport(subjectKey: string, projectId: string, signal?: AbortSignal) {
		const project = this.permissions.defaultScope
		const context = this.permissions.context(project.value(projectId))
		return this.permissions.can(this.exportReport, {
			subjectKey,
			context,
			...(signal ? { signal } : {}),
		})
	}
}
```

`can()` 返回布尔结果。默认效果为 `deny`，声明时可设 `defaultEffect: 'allow'`。取消透传 `AbortSignal.reason`，共享的冷加载可继续供其他调用使用。存储、背压和生命周期错误通过 Promise 拒绝报告。

## 多维范围和事件视图

平台适配器可导出 `defineScopeKey('discord.guild', codecs.bigintId)`，使用者调用 `permissions.registerScope(definition)` 获取绑定键。相同键与 codec 在一个节点共享，预注册的 `defaultScope` 使用 `stringId`。可用 codec 包括原文字符串、安全整数和大整数。一个 Context 每个键接收一个 `key.value(...)`。

授权范围使用 `key.eq(value)` 或 `key.oneOf(values)`。 `allOf(guild.eq(5n), channel.oneOf(['a', 'b']))` 同时要求两个维度命中。同一个键的候选之间满足其一即可，每个条件最多 128 个候选。省略范围表示全局。管理快照和 Workbench 使用 `[{ key: 'discord.guild', values: ['5'] }]` 之类的 codec 文本， `[]` 表示全局。

在同一事件检查多个动作时，获取 `await permissions.access({ subjectKey, context })` 后直接调用 `view.can(handle)`、`view.checkMany(handles)` 或 `view.filterAllowed(items, permissionOf)`。 `view.decide(handle)` 提供原因，若胜出层的拒绝均为临时授权，还提供该层的最晚拒绝截止时间 `until`。 `view.roles()` 和 `view.maxRank()` 读取当前生效的角色及最高等级，`view.outranks(target)` 要求严格高于另一主体视图或 `{ rank }`。经过异步操作后，敏感动作执行前可重新获取视图或调用一次 `can()`。视图失效时同步抛出 `STALE_VIEW`。

## 策略顺序

有效动作依次检查超级主体、主体直接规则、显式角色、常驻基础组 `@everyone` 和动作默认效果。命中明确裁决后即停止。显式角色等级越高越先裁决，同等级冲突时拒绝优先。无等级角色的规则在显式 rank 0 层裁决，主体间的等级比较只使用数字等级。基础组永远生效，可以重命名和编辑授权。

同一归属、范围和到期时间内，精确动作优先于最长通配前缀，`*` 兜底。例如，同桶 `report.*` 拒绝与 `report.read` 允许会放行读操作。同层其他范围桶的匹配拒绝仍可胜出。成员绑定与角色授权分别匹配上下文，同一角色有多个有效绑定时取最晚到期时间。有限 `expiresAt` 使用未来的 Unix 毫秒时间，到点立即失效。临时禁言可写为主体直接拒绝。

## 修改、解释和清理

管理写操作携带 `expectedRevision`，可以先从 `listRoles()` 或对应的策略列表读取版本。一次 `applyChanges()` 原子提交多条授权与成员变更。也可用 `setGrant()`、`assignRole()` 和按 ID 撤销的入口。`replaceSubjectRoles()` 将指定 Selector 下的显式绑定替换为给定的永久角色集合。下面的脚本接收已声明该动作的报表插件定义地址，为主体授予当前项目的导出权限。

```ts
import type { Script } from '@pluxel/agent-sdk/host'
import { parsePluginDefinitionAddress } from '@pluxel/core'
import { Permissions } from '@pluxel/plugin-permissions'

export default (async (sdk, { input }) => {
	const definition = parsePluginDefinitionAddress(input)
	const { instance: permissions } = await sdk.plugin(Permissions.nodeAddress()).instance()
	const { policyRevision } = await permissions.listRoles()
	const result = await permissions.setGrant({
		expectedRevision: policyRevision,
		owner: { kind: 'subject', subjectKey: 'account:42' },
		definition,
		pattern: 'report.export',
		selector: permissions.defaultScope.eq('project:A'),
		effect: 'allow',
	})
	if (result.isErr()) return { saved: false as const, ...result.error }
	return { saved: true as const, revision: result.value.policyRevision }
}) satisfies Script
```

`REVISION_CONFLICT` 提供当前版本，重新读取并核对后提交。 `INVALID_POLICY` 提供输入位置。 `COMMIT_UNKNOWN` 可能已提交，等待引擎恢复后读取事实再决定下一步。恢复期间读取可能报告 `NOT_READY`。

`explain()` 读取原始记录并返回胜出来源、授权与绑定 ID、范围以及有界步骤。 `effectivePermissions()` 返回指定上下文中生效的动作。 `listByScope({ key, value })` 和 `clearScopePolicy({ key, value, expectedRevision })` 按 codec 文本查看和清理单键单值记录。复合、多个候选及离线记录可通过策略列表定位并按 ID 撤销。 `clearSubjectPolicy()` 退役主体，`pruneExpired()` 清理到期历史。分页中版本变化时重新从首页读。

## 配置与 Workbench

使用公开的 `PermissionsConfig`。 `superSubjects` 由部署配置管理。 `cache.maxOwners` 默认 4,096， `cache.maxBytes` 默认 64 MiB。未安装 Workbench 时业务能力可照常运行。

安装 Workbench 后，可在权限页测试多维上下文、查看动作和 codec、管理角色等级和成员绑定、查看主体有效等级、按范围确认清理。省略 `workbench` 时使用 Host 的已认证会话。显式配置使用 `readers` 和 `writers` 中的 `{ provider, subject }` 匹配会话，`{}` 拒绝所有 Workbench 会话。
