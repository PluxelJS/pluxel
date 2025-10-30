export interface NumberCheck {
	/** 最小值（含） */
	min?: number
	/** 最大值（含） */
	max?: number
	/** 必须为整数 */
	integer?: boolean
}

export type NumberMetaOptions =
	| { type: 'slider'; options: SliderOptions & NumberCheck }
	| { type: 'input'; options: InputOptions & NumberCheck }

/** 滑块模式的可选项 */
export interface SliderOptions {
	min?: number
	max?: number
	step?: number
	/** 刻度标记 */
	marks?: { value: number; label?: string }[]
}

/** 普通输入模式的可选项 */
export interface InputOptions {
	/** 格式化选项，直接传给 Intl.NumberFormat */
	formatOptions?: Intl.NumberFormatOptions
	min?: number
	max?: number
	step?: number
}
