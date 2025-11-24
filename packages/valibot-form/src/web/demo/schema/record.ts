// src/forms/schemas/record-demo.ts
import * as v from 'valibot'
import * as f from '~/index'

/** 1) 表格模式：可增删、可改 key、列宽配置 */
export const RecordTableSchema = v.object({
	table: v.pipe(
		v.record(v.string(), v.boolean()),
		f.formMeta({ label: '表格模式 Record' }),
		f.recordMeta({
			layout: 'table',
			keyPlaceholder: '例如：api-key',
			valuePlaceholder: '值',
			columns: { key: 260, value: 'auto' },
		}),
	),
})

/** 2) 列表模式：key 固定不可编辑（例如系统字段） */
export const RecordListFixedKeySchema = v.object({
	fixed: v.pipe(
		v.record(v.string(), v.number()),
		f.formMeta({ label: '固定键 Record' }),
		f.recordMeta({
			editableKey: false,
			keyPlaceholder: '键',
			valuePlaceholder: '值',
			emptyHint: '暂无配置项',
			layout: 'list',
		}),
	),
})

/** 3) 值类型混合（数值/布尔/对象）以验证编辑器自适应 */
export const RecordMixedValueSchema = v.object({
	mixed: v.pipe(
		v.record(v.string(), v.unknown()),
		f.formMeta({ label: '混合类型 Record' }),
		f.recordMeta({
			layout: 'table',
			columns: { key: 240, value: 'auto' },
		}),
	),
})

/** 4) 汇总便于回归 */
export const RecordAllInOneSchema = v.object({
	...RecordTableSchema.entries,
	...RecordListFixedKeySchema.entries,
	...RecordMixedValueSchema.entries,
})

// —— 带默认值版本，便于观测 defaultValue 行为 —— //
export const RecordWithDefaultsSchema = v.object({
	table: v.optional(
		v.pipe(
			v.record(v.string(), v.unknown()),
			f.formMeta({ label: '表格模式 Record' }),
			f.recordMeta({
				layout: 'table',
				keyPlaceholder: '例如：api-key',
				valuePlaceholder: '值',
				columns: { key: 260, value: 'auto' },
			}),
		),
		{
			'api-key': 'abc-123',
			retries: 3,
			enabled: true,
			meta: { a: 1, b: [2, 3] },
		},
	),
	fixed: v.optional(
		v.pipe(
			v.record(v.string(), v.number()),
			f.formMeta({ label: '固定键 Record' }),
			f.recordMeta({
				editableKey: false,
				keyPlaceholder: '键',
				valuePlaceholder: '值',
				emptyHint: '暂无配置项',
				layout: 'list',
			}),
		),
		{
			region: 1,
			zone: 2,
		},
	),
	mixed: v.optional(
		v.pipe(
			v.record(v.string(), v.unknown()),
			f.formMeta({ label: '混合类型 Record' }),
			f.recordMeta({
				layout: 'table',
				columns: { key: 240, value: 'auto' },
			}),
		),
		{
			count: 5,
			debug: false,
			config: { x: 1, y: { z: 2 } },
		},
	),
})

export const RecordFocusTestSchema = v.object({
	table: v.pipe(
		v.record(v.string(), v.unknown()),
		f.formMeta({ label: '表格测试' }),
		f.recordMeta({
			layout: 'table',
			keyPlaceholder: '键',
			valuePlaceholder: '值',
			columns: { key: 240, value: 'auto' },
			valueMode: 'auto', // 初次推断后即固定
		}),
	),
	list: v.pipe(
		v.record(v.string(), v.unknown()),
		f.formMeta({ label: '列表测试' }),
		f.recordMeta({
			layout: 'list',
			keyPlaceholder: '键',
			valuePlaceholder: '值',
			valueMode: 'boolean', // 强制 JSON 编辑（即使当前是字符串也不切控件）
		}),
	),
})

export const RecordFocusTestDefaults = v.object({
	table: v.optional(RecordFocusTestSchema.entries.table, {
		name: 'alpha',
		count: 1,
		enabled: true,
		meta: { a: 1, b: [2, 3] },
	}),
	list: v.optional(RecordFocusTestSchema.entries.list, {
		notes: '{ "x": 1 }', // 有意用字符串测试 json 模式的"固定编辑器"
	}),
})

/** 5) Record with picklist values - 单选 */
export const RecordPicklistSingleSchema = v.object({
	permissions: v.optional(
		v.pipe(
			v.record(v.string(), v.picklist(['read', 'write', 'admin'])),
			f.formMeta({ label: '权限配置 (单选)', description: '为每个资源分配权限级别' }),
			f.recordMeta({
				layout: 'table',
				keyLabel: '资源名称',
				valueLabel: '权限级别',
				keyPlaceholder: '例如：users',
				valueMode: 'picklist',
				picklist: {
					options: ['read', 'write', 'admin'],
					labels: {
						read: '只读',
						write: '读写',
						admin: '管理员',
					},
				},
			}),
		),
		{
			users: 'admin',
			posts: 'write',
			comments: 'read',
		},
	),
})

/** 6) Record with picklist array values - 多选 */
export const RecordPicklistMultiSchema = v.object({
	tags: v.optional(
		v.pipe(
			v.record(v.string(), v.array(v.picklist(['frontend', 'backend', 'devops', 'design', 'qa']))),
			f.formMeta({ label: '项目标签 (多选)', description: '为每个项目分配多个标签' }),
			f.recordMeta({
				layout: 'table',
				keyLabel: '项目名称',
				valueLabel: '标签',
				keyPlaceholder: '例如：website',
				valueMode: 'picklist-array',
				picklist: {
					options: ['frontend', 'backend', 'devops', 'design', 'qa'],
					labels: {
						frontend: '前端',
						backend: '后端',
						devops: '运维',
						design: '设计',
						qa: '测试',
					},
					placeholder: '选择标签...',
					searchable: true,
					maxValues: 3,
				},
			}),
		),
		{
			website: ['frontend', 'design'],
			api: ['backend'],
			mobile: ['frontend'],
		},
	),
})

/** 7) Record with picklist array - stack layout */
export const RecordPicklistStackSchema = v.object({
	features: v.optional(
		v.pipe(
			v.record(
				v.string(),
				v.array(v.picklist(['auth', 'api', 'websocket', 'cache', 'queue', 'cron'])),
			),
			f.formMeta({ label: '功能配置 (堆栈布局)', description: '为每个模块选择启用的功能' }),
			f.recordMeta({
				layout: 'list',
				keyLabel: '模块名称',
				valueLabel: '启用功能',
				keyPlaceholder: '例如：user-service',
				valueMode: 'picklist-array',
				picklist: {
					options: ['auth', 'api', 'websocket', 'cache', 'queue', 'cron'],
					labels: {
						auth: '认证',
						api: 'API',
						websocket: 'WebSocket',
						cache: '缓存',
						queue: '队列',
						cron: '定时任务',
					},
					variant: 'select',
				},
			}),
		),
		{
			'user-service': ['auth', 'api', 'cache'],
			'notification-service': ['websocket', 'queue'],
		},
	),
})
