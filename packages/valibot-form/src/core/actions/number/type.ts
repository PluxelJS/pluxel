/**
 * 数字校验规则（从 valibot schema 自动提取）
 */
export interface NumberCheck {
	/** 最小值（含） */
	min?: number
	/** 最大值（含） */
	max?: number
	/** 必须为整数 */
	integer?: boolean
}

/**
 * 数字输入控件类型
 */
export type NumberInputVariant =
	| 'input' // 数字输入框
	| 'slider' // 滑块选择器

/**
 * 数字字段配置选项
 */
export interface NumberMetaOptions extends NumberCheck {
	/** 输入控件类型 */
	variant?: NumberInputVariant

	/** 步进值（每次增减的数量） */
	step?: number

	/** 输入框占位符文本 */
	placeholder?: string

	/** 输入框前缀文本（显示在输入框左侧，如货币符号 $） */
	prefix?: string

	/** 输入框后缀文本（显示在输入框右侧，如单位 kg） */
	suffix?: string

	/** 数字格式化选项（用于显示格式化后的数字） */
	formatOptions?: Intl.NumberFormatOptions

	/** 滑块刻度标记（variant = 'slider' 时有效） */
	marks?: { value: number; label?: string }[]

	/** 附加提示信息 */
	note?: string
}
