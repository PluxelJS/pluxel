/**
 * 常量定义 - 消除魔法数字
 */

// 表单布局
export const GRID_COLUMN_THRESHOLD = 3 // 紧凑字段数量达到此值时启用双列布局
export const DEFAULT_GRID_COLUMNS = 2

// Section
export const DEFAULT_SECTION_ID = '__autoform_default_section'

// 默认文本
export const DEFAULT_TEXTS = {
	array: {
		addItem: '添加一项',
		removeItem: '删除',
		emptyHint: '暂无数据，点击下方按钮添加一项。',
		itemLabel: '条目',
	},
	validation: {
		required: '此字段为必填项',
		jsonError: 'JSON 格式错误',
	},
	errors: {
		autoFormContextMissing: '[valibot-form] AutoForm.* 组件必须在 <AutoForm> 内使用',
		extractionFailed: (schemaType: string) => `[valibot-form] 无法提取 schema 信息: ${schemaType}`,
	},
} as const
