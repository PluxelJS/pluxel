// record/type.ts

/**
 * Record 字段配置选项
 *
 * @example
 * ```ts
 * // 基础 Record 表格模式
 * const schema = v.pipe(
 *   v.record(v.string(), v.number()),
 *   recordMeta({
 *     layout: 'table',
 *     keyLabel: '键名',
 *     valueLabel: '数值',
 *   }),
 * )
 *
 * // Record 使用 picklist 单选
 * const permissionsSchema = v.pipe(
 *   v.record(v.string(), v.picklist(['read', 'write', 'admin'])),
 *   recordMeta({
 *     layout: 'table',
 *     valueMode: 'picklist',
 *     picklist: {
 *       options: ['read', 'write', 'admin'],
 *       labels: { read: '只读', write: '读写', admin: '管理员' },
 *     },
 *   }),
 * )
 *
 * // Record 使用 picklist 多选（数组）
 * const tagsSchema = v.pipe(
 *   v.record(v.string(), v.array(v.picklist(['frontend', 'backend']))),
 *   recordMeta({
 *     layout: 'table',
 *     valueMode: 'picklist-array',
 *     picklist: {
 *       options: ['frontend', 'backend'],
 *       maxValues: 3,
 *     },
 *   }),
 * )
 * ```
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

	/**
	 * 布局模式
	 *
	 * - `'table'`: 表格布局（默认）
	 * - `'list'`: 卡片堆栈布局
	 */
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

	/**
	 * 值的类型模式（决定使用哪种输入控件）
	 *
	 * - `'auto'`: 自动推断（默认）
	 * - `'string'`: 文本输入框
	 * - `'number'`: 数值输入框
	 * - `'boolean'`: 开关按钮
	 * - `'json'`: JSON 编辑器
	 * - `'picklist'`: 单选下拉框
	 * - `'picklist-array'`: 多选下拉框（值为数组）
	 * - `'object' | 'array' | 'union' | 'variant'`: 嵌套表单（自动渲染子 schema）
	 */
	valueMode?: 'auto' | 'string' | 'number' | 'boolean' | 'json' | 'picklist' | 'picklist-array' | 'object' | 'array' | 'union' | 'variant'

	/** 最少键值对数量 */
	minItems?: number

	/** 最多键值对数量 */
	maxItems?: number

	/**
	 * 当 valueMode === 'picklist' 或 'picklist-array' 时的配置
	 *
	 * @example
	 * ```ts
	 * picklist: {
	 *   options: ['read', 'write', 'admin'],
	 *   labels: { read: '只读', write: '读写', admin: '管理员' },
	 *   searchable: true,
	 *   maxValues: 3, // 仅 picklist-array 时有效
	 * }
	 * ```
	 */
	picklist?: {
		/** 可选项列表 */
		options: readonly (string | number)[]
		/** 富选项配置（可选） */
		entries?: readonly {
			value: string | number
			label?: string
			description?: string
			group?: string
			disabled?: boolean
			accentColor?: string
		}[]
		/** 自定义显示标签 */
		labels?: Partial<Record<string | number, string>>
		/** 禁用的选项 */
		disabled?: readonly (string | number)[]
		/** 占位符文本 */
		placeholder?: string
		/** 是否可搜索 */
		searchable?: boolean
		/** 是否可清除 */
		clearable?: boolean
		/** 最大选择数量（仅 picklist-array 时有效） */
		maxValues?: number
		/** 渲染方式 */
		variant?: 'select' | 'segmented' | 'radio'
		/** 是否允许创建新选项 */
		allowCreate?: boolean
		/** 无匹配时的提示文本 */
		nothingFoundLabel?: string
	}

	/** 记录值的 schema，供嵌套表单渲染（自动注入） */
	valueSchema?: unknown
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
