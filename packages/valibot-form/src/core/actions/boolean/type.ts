/**
 * 布尔字段配置选项
 */
export interface BooleanMetaOptions {
	/** 控件类型（开关或复选框） */
	variant?: 'switch' | 'checkbox'

	/** 标签位置（相对于控件） */
	labelPlacement?: 'left' | 'right'

	/** 附加提示信息 */
	note?: string
}
