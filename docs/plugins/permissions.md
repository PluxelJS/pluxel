---
title: 权限管理（Permissions）
description: 为业务插件声明动作，使用外部主体键、权限组和精确范围统一鉴权。
---

`@pluxel/plugin-permissions` 是工作区预览。应用负责识别主体与目标资源。Permissions 保存策略，通过业务插件声明的动作判断该主体能否执行一次操作。

## 装配与鉴权

在应用的固定插件中加入 `{ plugin: Permissions, autoStart: true }`，在 Host 的 `services` 中安装一个 `Sqlite` 驱动。本地 Node 宿主可使用 `libsql({ directory: './data/sqlite' })`。同一策略库的所有检查和编辑交给同一个活动 Permissions 节点。[数据库驱动装配](../host/configuration.md#数据库服务后端选择)

业务插件通过构造函数注入 Permissions，在 `init` 中声明动作。下面的 `Reports` 同样加入应用的固定插件。调用入口在认证完成后把主体键和从真实资源解析出的项目键交给 `export`。

```ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { Permissions, type PermissionHandle } from '@pluxel/plugin-permissions'

@Plugin()
export class Reports extends BasePlugin {
	private exportAction!: PermissionHandle

	constructor(private readonly permissions: Permissions) {
		super()
	}

	protected override init() {
		this.exportAction = this.permissions.declare({ action: 'report.export' })
	}

	async export(request: { subjectKey: string; scopeKey: string; signal?: AbortSignal }) {
		if (typeof request.scopeKey !== 'string') throw new TypeError('导出需要项目键')
		if (!(await this.permissions.check(this.exportAction, request))) return { allowed: false }
		return { allowed: true, csv: 'month,total\nJune,12\n' }
	}
}
```

省略动作的 `defaultEffect` 时默认拒绝。请求省略 `scopeKey` 时检查全局，显式传入的范围须为非空字符串。主体键与范围键按原值比较，要求良构 Unicode，拒绝 NUL。句柄随声明插件自动释放。已取消请求、错误输入或必要的存储读取失败会抛出异常，`false` 表示完成了策略裁决并拒绝操作。

## 授权与排查

在 Workbench 打开当前节点的「权限」。先为「审阅」组给报表动作设全局允许，再把 `chatbot:42` 在 `project:A` 加入审阅组。项目只需填在成员绑定上。管理员可以给同一个组在另一范围设置例外，也能用主体直接规则覆盖组决策。撤销一条例外会恢复继承裁决。

在「测试权限」选择声明插件、输入同一主体、动作名和范围。结果显示 allow 或 deny、命中的规则、提供规则的组及其继承路径。还能跳到来源编辑，保存后沿用原输入复测。只读查询适用于没有授予任何权限的主体，也可以诊断当前未声明的动作。该操作无需执行报表导出。

Workbench 省略 Permissions 节点配置中的 `workbench` 时使用 Host 已认证的管理会话。要限制访问，可配置精确的 `readers` 和 `writers`，两者都使用 Host 管理身份的 `{ provider, subject }`。写者同时可读。配置对象一旦提供，仅名单内管理者可打开；空对象拒绝打开。无 Workbench 的宿主可以照常检查权限或运行可信管理脚本。[Workbench 使用](../workbench/operations.md)

可信脚本可从已运行的节点借用实例，使用 `listRules` 取得 `policyRevision` 再编辑。每次写入用 `expectedRevision` 匹配读到的版本。成功回执中的版本已经在当前节点生效。下面为主体在项目 A 设置直接拒绝，以工作区的报表插件为例。

```ts
import type { Script } from '@pluxel/agent-sdk/host'
import { Permissions } from '@pluxel/plugin-permissions'
import { Reports } from './reports'

export default (async ({ plugin }) => {
	const { instance: permissions } = await plugin(Permissions.nodeAddress()).instance()
	const owner = { kind: 'subject', subjectKey: 'chatbot:42' } as const
	const { policyRevision } = await permissions.listRules({ owner })
	const result = await permissions.setRule({
		owner,
		definition: Reports.address(),
		pattern: 'report.export',
		scopeKey: 'project:A',
		effect: 'deny',
		expectedRevision: policyRevision,
	})
	if (result.isOk()) return result.value
	if (result.error.code === 'REVISION_CONFLICT')
		return { recheckAtRevision: result.error.currentRevision }
	throw new Error(result.error.message)
}) satisfies Script
```

版本冲突后重新读取目标并确认意图。收到 `COMMIT_UNKNOWN` 时，存储恢复后先重读规则或成员关系确认修改是否生效。批量编辑在同一版策略中原子提交。[脚本调用](../development/scripts.md) · [优先级、存储与缓存设计](https://github.com/PluxelJS/plugins/blob/main/permissions/DESIGN.md)
