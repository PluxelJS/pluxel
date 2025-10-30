// src/forms/schemas/record-demo.ts
import * as v from 'valibot'
import * as f from '~/index'

/** 1) 表格模式：可增删、可改 key、列宽配置 */
export const RecordTableSchema = v.object({
	table: v.pipe(
		v.record(v.string(), v.boolean()),
		f.recordMeta({
			asTable: true,
			addable: true,
			removable: true,
			editableKey: true,
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
		f.recordMeta({
			addable: true,
			removable: true,
			editableKey: false,
			keyPlaceholder: '键',
			valuePlaceholder: '值',
			emptyHint: '暂无配置项',
		}),
	),
})

/** 3) 值类型混合（数值/布尔/对象）以验证编辑器自适应 */
export const RecordMixedValueSchema = v.object({
	mixed: v.pipe(
		v.record(v.string(), v.unknown()),
		f.recordMeta({
			asTable: true,
			addable: true,
			removable: true,
			editableKey: true,
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
	table: v.optional(RecordTableSchema.entries.table, {
		'api-key': 'abc-123',
		retries: 3,
		enabled: true,
		meta: { a: 1, b: [2, 3] },
	}),
	fixed: v.optional(RecordListFixedKeySchema.entries.fixed, {
		region: 'tokyo',
		zone: '1a',
	}),
	mixed: v.optional(RecordMixedValueSchema.entries.mixed, {
		count: 5,
		debug: false,
		config: { x: 1, y: { z: 2 } },
	}),
})

export const RecordFocusTestSchema = v.object({
	table: v.pipe(
		v.record(v.string(), v.unknown()),
		f.recordMeta({
			asTable: true,
			addable: true,
			removable: true,
			editableKey: true,
			keyPlaceholder: '键',
			valuePlaceholder: '值',
			columns: { key: 240, value: 'auto' },
			valueMode: 'auto', // 初次推断后即固定
		}),
	),
	list: v.pipe(
		v.record(v.string(), v.unknown()),
		f.recordMeta({
			addable: true,
			removable: true,
			editableKey: true,
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
		notes: '{ "x": 1 }', // 有意用字符串测试 json 模式的“固定编辑器”
	}),
})
