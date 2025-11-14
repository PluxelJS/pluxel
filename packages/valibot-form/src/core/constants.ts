/**
 * 常量定义 - 消除魔法数字
 */

// 表单布局
export const GRID_COLUMN_THRESHOLD = 4
export const DEFAULT_GRID_COLUMNS = 2

// 数组字段
export const VIRTUALIZATION_THRESHOLD = 100 // 超过此数量使用虚拟滚动
export const DEFAULT_MAX_TEXTAREA_ROWS = 12
export const DEFAULT_MIN_TEXTAREA_ROWS = 4

// Section
export const DEFAULT_SECTION_ID = '__autoform_default_section'

// 性能优化
export const DEBOUNCE_DELAY = 300 // ms

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
		rendererNotFound: (type: string) =>
			`[valibot-form] 未注册渲染器: "${type}". 请确保已经导入并注册对应的渲染器。`,
		autoFormContextMissing: '[valibot-form] AutoForm.* 组件必须在 <AutoForm> 内使用',
		extractionFailed: (schemaType: string) =>
			`[valibot-form] 无法提取 schema 信息: ${schemaType}`,
	},
} as const
