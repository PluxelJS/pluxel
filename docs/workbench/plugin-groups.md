---
title: 插件分组
description: 按依赖自动整理插件，并用界面或独立 JSON 文件维护人工分组。
---

插件列表默认根据依赖关系整理。你可以直接使用自动结果，也可以通过“编辑分组”新增、改名、删除分组，再拖动插件调整归属和顺序。
分组只影响管理界面，不会改变插件启停、依赖选择或配置。

## 没有分组配置时

- 一个业务入口和只为它服务的 required 依赖放在一起，名称使用入口插件的显示名。
- 多个业务入口共用的依赖集中到“共享依赖”，这些业务入口仍保持独立。
- 只有一个插件定义的集合保持平铺，不创建单成员自动组。fork 不计为另一个定义。
- 全部插件没有关联时直接显示“全部插件”；没有插件时不生成占位组。

例如“报告 → 文档处理”和“研究 → 数据集”会成为两个组；如果两边都使用“认证 → 存储”，认证和存储进入共享依赖组。
自动分类只考虑源码声明的 required 依赖，包括 Plugin Part 的依赖。optional integration、运行状态和当前选择的 provider 不影响分类。
抽象依赖考虑当前目录中声明实现该角色的全部插件。

新增或删除插件后自动结果随目录更新。依赖环作为一个整体处理；有多个业务入口时，共用的下游插件不会把业务合并成一个大组。
自动布局无法推断业务领域名称，需要业务名称时可以人工命名。

## 保存人工布局

“编辑分组”支持新增、改名和删除；删除分组会把当前成员移回未分组。拖动可以调整成员和顺序。
保存会固定当前布局，后续依赖改变不会打乱这些人工成员。尚未出现的新插件继续在未指定的插件中自动归类。
同一个插件定义的所有 fork 共用归属；移动任一成员时会一起移动整个 family，不能拆到不同组。

“恢复自动分组”清除人工设置，立即按当前依赖重新整理。空人工组会保留，方便继续拖入插件。

## 让 coding agent 编辑文件

分组独立存放在 persistence 根目录的 `management/plugin-groups.json`。例如配置
`persistence: './.pluxel/persistence'` 时，路径是 `.pluxel/persistence/management/plugin-groups.json`。
使用 memory persistence 时不会创建磁盘文件；自定义后端使用相同 namespace 和文件 key。

```json
{
	"version": 1,
	"groups": [
		{
			"id": "research",
			"name": "研究与资料",
			"plugins": [
				"package:@example/research::ResearchPlugin",
				"package:@example/documents::DocumentPlugin"
			]
		}
	],
	"ungrouped": ["package:@example/auth::AuthPlugin"]
}
```

- `id` 是自选的稳定组 key；改名时保持它不变。数组顺序就是组和成员顺序。
- `plugins` 使用 canonical definition reference，不使用 class display name 或 fork reference。包入口格式如上；源码入口使用
  `source:<sourceSpace>/<path>::<exportName>`，路径中的特殊字符遵循标准 Plugin reference 编码。
- `ungrouped` 明确指定保持平铺的插件；没有列出的插件继续自动分类。
- 暂时不在目录中的合法引用会保留，插件回来时恢复归属，不会因此安装或启动插件。
- 空文档 `{ "version": 1, "groups": [], "ungrouped": [] }` 与文件不存在都表示完全自动。无需预先生成全量分组文件。

文件需要包含这三个顶层字段；不接受重复组 key、重复插件归属、未知字段和非法引用。建议使用格式化 JSON，并原子替换文件。
文件变化会在下一次目录刷新时读取，不必重启宿主。语法或内容错误会显示读取失败，修复文件后重新刷新即可。
界面保存与文件编辑共用这份文档；避免同时编辑同一份布局，完整保存以最后成功写入为准。

操作运行中的开发应用时，coding agent 应按照[开发控制台流程](../development/dev-console.md)发现并固定实例，提交普通 TypeScript
操作，随后刷新目录检查结果。不要另建测试宿主来判断当前应用是否已更新。
