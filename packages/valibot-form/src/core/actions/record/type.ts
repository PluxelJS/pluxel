// record/type.ts

/**
 * Record 字段配置选项
 */
export type RecordMetaOptions = {
	/** 是否允许添加新键值对 */
	addable?: boolean

	/** 是否允许删除键值对 */
	removable?: boolean

	/** 是否允许重新排序 */
	reorderable?: boolean

	/** 键是否可编辑 */
	editableKey?: boolean

	/** 布局模式 */
	layout?: 'list' | 'table'

	/** @deprecated 使用 layout = 'table' */
	asTable?: boolean

	/** 列宽配置（仅 layout = 'table' 时有效） */
	columns?: { key?: number | string; value?: number | string }

	/** 键列标题 */
	keyLabel?: string

	/** 值列标题 */
	valueLabel?: string

	/** 键输入框占位符 */
	keyPlaceholder?: string

	/** 值输入框占位符 */
	valuePlaceholder?: string

	/** 空状态提示文本 */
	emptyHint?: string

	/** 添加按钮文本 */
	addLabel?: string

	/** 值的类型模式（决定使用哪种输入控件） */
	valueMode?: 'auto' | 'string' | 'number' | 'boolean' | 'json'

	/** 最少键值对数量 */
	minItems?: number

	/** 最多键值对数量 */
	maxItems?: number
}

/**
 * Record 提取结果（可包含键和值的子元数据）
 */
export type RecordMetaResult<TKeyMeta = unknown, TValueMeta = unknown> = RecordMetaOptions & {
	/** 键的子元数据 */
	key?: TKeyMeta
	/** 值的子元数据 */
	value?: TValueMeta
}
